/**
 * Regression tests for the instance manager's four state combinations.
 *
 * The one that matters most is "no local state, remote instance alive": it is what a container that
 * starts against a surviving engine hits (fresh volume, restored backup), and getting it wrong makes
 * every session unstartable with a 500 "instance already exists" from the create call. It was found
 * exactly that way — the first run inside Docker.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvolutionGoInstanceManager } from './evolution-go-instance';
import type { EvolutionGoClient } from './evolution-go-client';

const PREFIX = 'openwa-';
const SESSION = 'sess-1';
const REMOTE_NAME = PREFIX + SESSION;

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/** A client stand-in that answers the paths ensure() uses and records everything else. */
function makeClient(options: { remote: Array<Record<string, unknown>> }): {
  client: EvolutionGoClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client = {
    get: (path: string): Promise<unknown> => {
      calls.push({ method: 'GET', path });
      if (path === '/instance/all') return Promise.resolve(options.remote);
      return Promise.resolve({});
    },
    post: (path: string, opts?: { body?: Record<string, unknown> }): Promise<unknown> => {
      calls.push({ method: 'POST', path, body: opts?.body });
      if (path === '/instance/create') {
        const body = opts?.body ?? {};
        return Promise.resolve({ id: 'created-id', name: body.name, token: body.token });
      }
      return Promise.resolve({});
    },
    delete: (path: string): Promise<unknown> => {
      calls.push({ method: 'DELETE', path });
      return Promise.resolve({});
    },
  } as unknown as EvolutionGoClient;
  return { client, calls };
}

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'evo-inst-'));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function manager(client: EvolutionGoClient): EvolutionGoInstanceManager {
  return new EvolutionGoInstanceManager(client, { instancePrefix: PREFIX, stateDir });
}

describe('EvolutionGoInstanceManager.ensure', () => {
  it('ADOPTS a live remote instance when there is no local state at all', async () => {
    const { client, calls } = makeClient({
      remote: [{ id: 'remote-id', name: REMOTE_NAME, token: 'remote-token' }],
    });

    const instance = await manager(client).ensure(SESSION);

    expect(instance).toEqual({ id: 'remote-id', name: REMOTE_NAME, token: 'remote-token' });
    // The regression: creating here answers 500 "instance already exists" on the real service.
    expect(calls.some(call => call.path === '/instance/create')).toBe(false);
  });

  it('persists the adopted instance, so the next start needs no remote lookup', async () => {
    const { client } = makeClient({
      remote: [{ id: 'remote-id', name: REMOTE_NAME, token: 'remote-token' }],
    });

    await manager(client).ensure(SESSION);

    const written = JSON.parse(readFileSync(join(stateDir, SESSION, 'instance.json'), 'utf8')) as {
      id: string;
      token: string;
    };
    expect(written).toMatchObject({ id: 'remote-id', token: 'remote-token' });
  });

  it('prefers the token the service discloses over the one we had', async () => {
    const first = makeClient({ remote: [{ id: 'remote-id', name: REMOTE_NAME, token: 'authoritative' }] });
    const instance = await manager(first.client).ensure(SESSION);
    expect(instance.token).toBe('authoritative');
  });

  it('creates the instance when neither side has one', async () => {
    const { client, calls } = makeClient({ remote: [] });
    const instance = await manager(client).ensure(SESSION);

    const create = calls.find(call => call.path === '/instance/create');
    expect(create?.body).toMatchObject({ name: REMOTE_NAME });
    expect(instance.id).toBe('created-id');
  });

  it("ignores remote instances that do not carry this deployment's prefix", async () => {
    const { client, calls } = makeClient({
      remote: [{ id: 'other', name: 'turbozap-something', token: 't' }],
    });

    await manager(client).ensure(SESSION);

    // Someone else's instance is not ours to adopt: a create is the correct outcome.
    expect(calls.some(call => call.path === '/instance/create')).toBe(true);
  });

  it('recreates under the SAME name when the instance disappeared but our state survived', async () => {
    const withRemote = makeClient({ remote: [{ id: 'remote-id', name: REMOTE_NAME, token: 'tok' }] });
    const managerWithState = manager(withRemote.client);
    await managerWithState.ensure(SESSION);

    // Same state dir, but the engine no longer reports the instance.
    const withoutRemote = makeClient({ remote: [] });
    const fresh = new EvolutionGoInstanceManager(withoutRemote.client, {
      instancePrefix: PREFIX,
      stateDir,
    });
    await fresh.ensure(SESSION);

    const create = withoutRemote.calls.find(call => call.path === '/instance/create');
    expect(create?.body).toMatchObject({ name: REMOTE_NAME, token: 'tok' });
  });
});
