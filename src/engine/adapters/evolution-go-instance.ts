/**
 * Owns the mapping between an OpenWA session and its remote Evolution Go INSTANCE.
 *
 * One session is one remote instance, named `<prefix><session name>`. This file is the only place
 * that knows how that instance is created, found again, and removed.
 *
 * Why local state exists at all: the engine service owns the WhatsApp credentials, but the TOKEN this
 * gateway authenticates with is issued at create time and the gateway must present it on every
 * scoped call. Without persisting it, a gateway restart could not talk to an instance that is still
 * perfectly linked — the session would look dead while the phone still shows it as connected. So the
 * id + token live on disk under the engine's own state dir, exactly like the sibling engines' auth
 * dirs, and are removed by the same purge path when a session is deleted.
 *
 * Presence is verified against the service rather than trusted from disk: an operator can delete an
 * instance (or restore the service's database) while our state file still names it, and using a
 * stale token then fails on every call with a 403 that looks like a misconfigured key.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensurePrivateDir } from '../../common/utils/private-dir.util';
import { createLogger, LoggerService } from '../../common/services/logger.service';
import { EvolutionGoClient } from './evolution-go-client';

/** An instance as the service reports it. `token` is present only when the service discloses it. */
export interface EvolutionGoRemoteInstance {
  id: string;
  name: string;
  token?: string;
}

/** What we persist per session. */
interface PersistedInstanceState {
  id: string;
  name: string;
  token: string;
}

export interface EvolutionGoInstanceManagerOptions {
  instancePrefix: string;
  /** Base dir for per-session state; a `<session name>/instance.json` lives under it. */
  stateDir: string;
}

/** Narrowing helper for the service's loosely-typed JSON. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export class EvolutionGoInstanceManager {
  private readonly logger: LoggerService = createLogger('EvolutionGoInstance');
  /** Resolved per session for the life of this manager (one manager per engine adapter). */
  private readonly resolved = new Map<string, PersistedInstanceState>();

  constructor(
    private readonly client: EvolutionGoClient,
    private readonly options: EvolutionGoInstanceManagerOptions,
  ) {}

  /** The remote instance name for a session. Deterministic, so a restart finds the same instance. */
  remoteName(sessionName: string): string {
    return `${this.options.instancePrefix}${sessionName}`;
  }

  /**
   * Returns the instance for a session, creating it when absent.
   *
   * The remote list is consulted once here (then cached on the instance) because the common case is
   * a session restarting against an instance that already exists and is already linked — creating a
   * second one would silently require a fresh QR scan.
   */
  async ensure(sessionName: string): Promise<PersistedInstanceState> {
    const cached = this.resolved.get(sessionName);
    if (cached) return cached;

    const name = this.remoteName(sessionName);
    const persisted = this.readState(sessionName);
    const remote = await this.findRemote(name);

    // The remote instance is the source of truth whenever it exists. This covers the case that has
    // NO local state at all — a fresh container, a reset volume, a restored backup — against
    // instances that are still alive and still linked. Falling through to create() there answers
    // 500 "instance already exists" and leaves the session unstartable, which is exactly what
    // happened the first time this ran inside a container.
    if (remote) {
      // The service's own copy of the token wins when it discloses one: it is the value it will
      // actually check. Its absence (older builds) falls back to ours.
      const token = remote.token ?? persisted?.token;
      if (!token) {
        // Neither side has a usable token, so the instance cannot be authenticated against. It is
        // still occupying the name, so it has to go before a new one can take it — which means a
        // fresh pairing, and that is worth saying out loud rather than failing obscurely.
        this.logger.warn(
          `Evolution Go instance '${name}' exists but no token is available for it; removing it so the session can be paired again`,
          { action: 'instance_token_lost' },
        );
        await this.deleteRemote(remote);
        return this.create(sessionName, name, randomUUID());
      }

      const instance: PersistedInstanceState = { id: remote.id, name, token };
      this.resolved.set(sessionName, instance);
      // Re-persist when it disagrees with what we had (or when we had nothing): the file is what
      // makes the NEXT start cheap, and a stale id in it is worse than none.
      if (!persisted || instance.token !== persisted.token || instance.id !== persisted.id) {
        this.writeState(sessionName, instance);
        this.logger.log(`Adopted the existing Evolution Go instance for session '${sessionName}'`, {
          action: 'instance_adopted',
        });
      }
      return instance;
    }

    if (persisted) {
      // The remote side lost the instance (deleted by hand, or its database was restored) while our
      // state file survived. Recreate under the SAME name and token so the state file stays valid.
      this.logger.warn(`Evolution Go instance '${name}' is gone; recreating it for session '${sessionName}'`, {
        action: 'instance_recreate',
      });
      return this.create(sessionName, name, persisted.token);
    }

    return this.create(sessionName, name, randomUUID());
  }

  /**
   * Creates the instance, then configures its webhook in the same breath.
   *
   * The token is ours to choose — the service accepts a caller-supplied one — which is what makes
   * the persisted state authoritative instead of something to be discovered later.
   */
  private async create(sessionName: string, name: string, token: string): Promise<PersistedInstanceState> {
    const created = await this.client.post<Record<string, unknown>>('/instance/create', {
      body: { name, token },
    });

    const id = asString(created?.id) ?? name;
    const effectiveToken = asString(created?.token) ?? token;
    const instance: PersistedInstanceState = { id, name, token: effectiveToken };

    this.writeState(sessionName, instance);
    this.resolved.set(sessionName, instance);
    this.logger.log(`Evolution Go instance created for session '${sessionName}'`, {
      action: 'instance_created',
    });
    return instance;
  }

  /** Every instance this deployment owns, i.e. carrying the configured prefix. */
  async listOwned(): Promise<EvolutionGoRemoteInstance[]> {
    const listed = await this.client.get<unknown>('/instance/all');
    if (!Array.isArray(listed)) return [];
    return listed
      .map(entry => (typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : null))
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .map(entry => ({
        id: asString(entry.id) ?? asString(entry.instanceId) ?? '',
        name: asString(entry.name) ?? asString(entry.instanceName) ?? '',
        token: asString(entry.token),
      }))
      .filter(instance => instance.id !== '' && instance.name.startsWith(this.options.instancePrefix));
  }

  private async findRemote(name: string): Promise<EvolutionGoRemoteInstance | undefined> {
    const owned = await this.listOwned();
    return owned.find(instance => instance.name === name);
  }

  /** Deletes the instance on the service side. Safe when it is already gone. */
  async deleteRemote(instance: EvolutionGoRemoteInstance): Promise<void> {
    try {
      await this.client.delete(`/instance/delete/${encodeURIComponent(instance.id)}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // A 404 means the desired state already holds; anything else is worth knowing about but must
      // not block the local teardown that follows it.
      this.logger.warn(`Could not delete Evolution Go instance '${instance.name}': ${detail}`, {
        action: 'instance_delete_failed',
      });
    }
  }

  /** Drops the in-memory handle so the next `ensure` re-reads (or re-creates) from scratch. */
  forget(sessionName: string): void {
    this.resolved.delete(sessionName);
  }

  /** Removes the persisted state. Called on logout/delete, alongside the credential-dir purge. */
  purgeState(sessionName: string): void {
    this.resolved.delete(sessionName);
    rmSync(this.instanceDir(sessionName), { recursive: true, force: true });
  }

  private instanceDir(sessionName: string): string {
    return join(this.options.stateDir, sessionName);
  }

  private statePath(sessionName: string): string {
    return join(this.instanceDir(sessionName), 'instance.json');
  }

  private readState(sessionName: string): PersistedInstanceState | null {
    try {
      const raw = readFileSync(this.statePath(sessionName), 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedInstanceState>;
      if (typeof parsed.id === 'string' && typeof parsed.name === 'string' && typeof parsed.token === 'string') {
        return { id: parsed.id, name: parsed.name, token: parsed.token };
      }
      return null;
    } catch {
      // Absent (first run) or unreadable/corrupt. Either way the caller recreates the instance, which
      // is the only recovery available — a corrupt token cannot be guessed.
      return null;
    }
  }

  private writeState(sessionName: string, state: PersistedInstanceState): void {
    const dir = this.instanceDir(sessionName);
    // Owner-only, like every other directory holding something that can take over the linked
    // account: the instance token authorizes sends as that account.
    ensurePrivateDir(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.statePath(sessionName), JSON.stringify(state, null, 2), { mode: 0o600 });
  }
}
