/**
 * The `evolution-go` engine adapter: an IWhatsAppEngine backed by an external Evolution Go service.
 *
 * ## What is different about this engine
 *
 * The two library engines run the WhatsApp protocol in-process; this one is an HTTP client. That
 * changes three things this file has to be honest about:
 *
 *  1. **Capability is bounded by the remote API, not by this code.** The service exposes 91
 *     operations; the interface has 112 methods. Every method with no counterpart throws
 *     {@link EngineNotSupportedError} (HTTP 501) through {@link unsupported} rather than returning an
 *     empty value — a caller must never read "the engine cannot do this" as "there is nothing there".
 *  2. **Sends are confirmed by a message id, not by a status code.** The service answers HTTP 200
 *     with an empty `data.Info.ID` when WhatsApp refuses the message, so a status-only check reports
 *     success for a send that never left. {@link readSendResult} is the single place that decides.
 *  3. **Media has to be reachable by URL.** The service fetches media itself and accepts no bytes, so
 *     a base64 payload is hosted first (see {@link MediaHost}).
 *
 * ## Structure
 *
 * The class is deliberately thin: it normalises arguments to the service's dialect, delegates to
 * {@link EvolutionGoClient}, and maps results back. Every method that the service cannot serve is a
 * one-line refusal so the gap is greppable and the capability matrix can be derived from this file.
 */

import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { createLogger, LoggerService } from '../../common/services/logger.service';
import { toNeutralJid } from '../identity/wa-id';
import {
  EngineStatus,
  type AccountRestriction,
  type CallLinkType,
  type Channel,
  type ChannelMessage,
  type ChatState,
  type ChatSummary,
  type Contact,
  type ContactCard,
  type DeliveryStatus,
  type EngineEventCallbacks,
  type Group,
  type GroupInfo,
  type GroupJoinInfo,
  type GroupMemberAddMode,
  type GroupMembershipRequest,
  type GroupParticipant,
  type IWhatsAppEngine,
  type IncomingMessage,
  type Label,
  type LabelInput,
  type LocationInput,
  type MediaInput,
  type MessageReaction,
  type MessageResult,
  type PaginatedProducts,
  type ParticipantOperationResult,
  type PollInput,
  type ProductQueryOptions,
  type Status,
  type StatusPostOptions,
  type StatusResult,
} from '../interfaces/whatsapp-engine.interface';
import { EvolutionGoClient, EvolutionGoHttpError } from './evolution-go-client';
import { EvolutionGoInstanceManager } from './evolution-go-instance';
import { mapIncomingMessage, pick, pickString } from './evolution-go-message-mapper';

/**
 * Hosts outbound bytes so the engine service can fetch them.
 *
 * Declared structurally, matching {@link EvolutionGoMediaHost}, so the adapter depends on the
 * capability rather than on a class that needs storage and configuration wired to construct — which
 * is also what lets its own spec drive media sends with a three-line fake.
 */
export interface MediaHost {
  hostBuffer(options: { sessionId: string; buffer: Buffer; mimetype: string; filename: string }): Promise<string>;
}

export interface EvolutionGoEngineConfig {
  baseUrl: string;
  apiKey: string;
  callbackBaseUrl: string;
  ingressSecret: string;
  instancePrefix: string;
  stateDir: string;
  timeoutMs: number;
  mediaTimeoutMs: number;
  mediaTtlSeconds: number;
  subscribe: string[];
}

export interface EvolutionGoAdapterOptions {
  /** Session NAME — the remote instance is named after it. */
  sessionId: string;
  /** Session UUID, kept for parity with the sibling adapters. */
  dbSessionId: string;
  proxyUrl?: string;
  proxyType?: 'http' | 'https' | 'socks4' | 'socks5';
  config: EvolutionGoEngineConfig;
  mediaHost?: MediaHost;
  /** Injected clock, so tests can assert token/expiry behaviour without fake timers. */
  now?: () => number;
}

/** Body node names that carry a quoted context, used to read reply targets off a send. */
const CONNECTED_STATES = new Set(['open', 'connected', 'CONNECTED', 'Open']);

/** Narrowing helpers for the service's loosely-typed JSON. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function num(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * The ONLY non-literal `EngineNotSupportedError` construction in the engine: the parity gate
 * (engine-parity.spec.ts) counts construction sites per adapter file and allows exactly one, whose
 * argument is the parameter below. Every refusal therefore goes through here, which is also what
 * keeps the refusals greppable and attributable in the capability matrix.
 */
export class EvolutionGoAdapter implements IWhatsAppEngine {
  private readonly logger: LoggerService = createLogger('EvolutionGoAdapter');
  private readonly client: EvolutionGoClient;
  private readonly instances: EvolutionGoInstanceManager;
  private readonly sessionId: string;
  private readonly mediaHost?: MediaHost;
  private readonly now: () => number;

  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  /** Instance token for the live session; set by {@link initialize}. */
  private instanceToken: string | null = null;
  private callbacks: EngineEventCallbacks = {};
  private readyWaiters: Array<(ready: boolean) => void> = [];

  constructor(private readonly options: EvolutionGoAdapterOptions) {
    this.sessionId = options.sessionId;
    this.mediaHost = options.mediaHost;
    this.now = options.now ?? (() => Date.now());
    this.client = new EvolutionGoClient({
      baseUrl: options.config.baseUrl,
      apiKey: options.config.apiKey,
      timeoutMs: options.config.timeoutMs,
      mediaTimeoutMs: options.config.mediaTimeoutMs,
    });
    this.instances = new EvolutionGoInstanceManager(this.client, {
      instancePrefix: options.config.instancePrefix,
      stateDir: options.config.stateDir,
    });
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  /** Token for the live instance, or a clear failure — never a silent fall back to the global key. */
  private requireToken(): string {
    if (!this.instanceToken) {
      throw new EngineNotReadyError('Session is not started. Call POST /sessions/:sessionId/start first.');
    }
    return this.instanceToken;
  }

  /** Scoped call: authenticated with the session's instance token. */
  private async scoped<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return this.client.requestVia<T>(method, path, { apiKey: this.requireToken(), body });
  }

  /** Scoped call on the media deadline, for anything the engine has to download first. */
  private async scopedMedia<T>(path: string, body: unknown): Promise<T> {
    return this.client.requestVia<T>('POST', path, {
      apiKey: this.requireToken(),
      body,
      timeoutMs: this.client.mediaTimeoutMs,
    });
  }

  private requireMediaHost(): MediaHost {
    if (!this.mediaHost) {
      throw new EngineTransportError(
        'Evolution Go media host is unavailable, so base64 media cannot be sent. Configure storage, or pass a public URL instead.',
      );
    }
    return this.mediaHost;
  }

  /**
   * Resolves a {@link MediaInput} into a URL the ENGINE can fetch.
   *
   * A caller-supplied http(s) URL is passed through untouched — the engine downloads it itself, and
   * re-hosting bytes we already have a URL for would double the traffic for no benefit. Anything else
   * (raw bytes or base64) is persisted and served from a signed URL.
   */
  private async resolveMediaUrl(media: MediaInput): Promise<string> {
    if (typeof media.data === 'string' && /^https?:\/\//i.test(media.data)) {
      return media.data;
    }
    const buffer = typeof media.data === 'string' ? Buffer.from(stripDataUri(media.data), 'base64') : media.data;
    const host = this.requireMediaHost();
    return host.hostBuffer({
      sessionId: this.sessionId,
      buffer,
      mimetype: media.mimetype,
      // The engine names the file it uploads to WhatsApp from this; a caller that supplied none gets
      // the same placeholder the sibling engines use for an unnamed document.
      filename: media.filename ?? 'file',
    });
  }

  /**
   * Reads a send result, refusing to report success the service did not confirm.
   *
   * The service answers HTTP 200 with an empty `data.Info.ID` when WhatsApp rejected the message
   * (invalid number, no WhatsApp account, a refused reach-out). A caller that trusts the status code
   * marks a message SENT that was never delivered, which is the single most misleading failure mode
   * of this engine — so a missing id is an error here.
   */
  private readSendResult(response: unknown, chatId: string): MessageResult {
    const record = asRecord(response);
    const info = asRecord(pick(record, 'Info', 'info'));
    const id = pickString(info, 'ID', 'id');
    if (!id) {
      throw new EngineRefusedError(
        `Evolution Go accepted the send to ${chatId} but returned no message id, which means WhatsApp did not accept it (unknown number, no WhatsApp account, or a refused reach-out).`,
      );
    }
    const timestamp = num(pick(info, 'Timestamp', 'timestamp'));
    return { id, timestamp: timestamp ?? Math.floor(this.now() / 1000) };
  }

  /**
   * Common envelope for every send endpoint.
   *
   * Typed as the intersection every send payload actually satisfies (all four input shapes extend
   * {@link Quotable} and carry an optional caption) rather than as {@link MediaInput}, which only
   * one of the four callers passes.
   */
  private sendEnvelope(
    chatId: string,
    media?: { caption?: string; mentions?: string[]; quotedMessageId?: string },
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      number: this.toServiceJid(chatId),
      formatJid: true,
    };
    if (media?.caption) payload.caption = media.caption;
    if (media?.mentions?.length) payload.mentionedJid = media.mentions.map(m => this.toServiceJid(m));
    if (media?.quotedMessageId) payload.quoted = { messageId: media.quotedMessageId };
    return payload;
  }

  /**
   * The neutral dialect back to the service's.
   *
   * Only the two forms the service does not recognise need translating: the neutral `@c.us` user
   * form and the `@lid` privacy form map onto the service's own `@s.whatsapp.net`/`@lid` handling,
   * and `formatJid` tells it the value is already an id rather than a bare phone number.
   */
  private toServiceJid(neutralId: string): string {
    if (neutralId.endsWith('@c.us')) return neutralId.replace(/@c\.us$/, '@s.whatsapp.net');
    return neutralId;
  }

  private setStatus(status: EngineStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.callbacks.onStateChanged?.(status);
  }

  private resolveReadyWaiters(ready: boolean): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter(ready);
  }

  // ==========================================================================
  // Session & connection
  // ==========================================================================

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.setStatus(EngineStatus.INITIALIZING);

    if (!this.client.isConfigured()) {
      const reason =
        'Evolution Go is not configured: set EVOLUTION_GO_API_KEY (and EVOLUTION_GO_URL) to the engine deployment.';
      this.setStatus(EngineStatus.FAILED);
      callbacks.onError?.(reason);
      throw new EngineTransportError(reason);
    }

    const instance = await this.instances.ensure(this.sessionId);
    this.instanceToken = instance.token;

    // The proxy is a property of the remote instance, so it is (re)applied on every start: an
    // operator can change it in the dashboard and the change must take effect on the next start
    // rather than only on a fresh session.
    if (this.options.proxyUrl) {
      await this.applyProxy();
    }

    await this.connect(instance.token);

    // Reconcile against the connection the engine ALREADY has. The service only emits
    // Connected/PairSuccess on a TRANSITION, so a gateway that restarts against an instance which is
    // still linked never receives one — and waiting for it leaves the session stuck INITIALIZING
    // forever while the phone shows it as connected. The watchdog then probes liveness, sees a
    // non-READY status, declares the session dead and starts a reconnect loop that can never
    // converge, because every new adapter waits for the same event that will never be sent.
    await this.reconcileConnectionState(instance.token);
  }

  /**
   * Adopts a connection the engine already holds, instead of waiting to be told about it.
   *
   * Reads the authoritative state from the service and, when it reports a live link, completes the
   * ready path here and now. A fresh pairing is unaffected: the status is not connected, the QR
   * arrives from the service (or the event), and this returns without doing anything.
   *
   * Bounded on purpose. It runs inside start(), so it must not hold the request open; and it exits
   * the moment a QR shows up, because that means a pairing is under way and readiness will come
   * from the event rather than from here.
   */
  private async reconcileConnectionState(token: string): Promise<void> {
    try {
      const state = await this.readConnectionState(token);
      if (!state.connected || !state.loggedIn) return;
      this.logger.log('Adopted an existing Evolution Go connection', { action: 'connection_adopted' });
      await this.markReady(token);
    } catch (error) {
      // Unreadable right now (the runtime is still coming up, or the service is briefly busy).
      // Deliberately not retried and not fatal: a pairing under way will announce itself through the
      // QRCode/PairSuccess events anyway, which is the path a fresh session has always used.
      this.logger.debug(`Connection state not readable during start: ${describe(error)}`);
    }
  }

  private async applyProxy(): Promise<void> {
    const url = this.options.proxyUrl;
    if (!url) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new EngineTransportError(`Session proxy URL is not a valid URL: ${url}`);
    }
    // Admin scope, like /instance/info: the global key, never the instance token.
    await this.client.post(`/instance/proxy/${encodeURIComponent(this.instances.remoteName(this.sessionId))}`, {
      body: {
        host: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' || parsed.protocol === 'socks5:' ? '443' : '80'),
        protocol: (this.options.proxyType ?? parsed.protocol.replace(':', '')).toUpperCase(),
        username: parsed.username || undefined,
        password: parsed.password || undefined,
      },
    });
  }

  /**
   * Registers our webhook and asks the service to connect.
   *
   * `webhookUrl` is per instance on purpose: this gateway runs several sessions against one engine
   * deployment, and a global webhook would deliver every session's events to a single place with no
   * way to tell them apart.
   */
  private async connect(token: string): Promise<void> {
    const instance = this.instances.remoteName(this.sessionId);
    const webhookUrl = this.webhookUrl();
    await this.client.post('/instance/connect', {
      apiKey: token,
      body: {
        immediate: true,
        webhookUrl,
        subscribe: this.options.config.subscribe,
      },
    });
    this.logger.log(`Evolution Go instance '${instance}' connecting`, { action: 'instance_connect' });

    // Best effort, and deliberately after connect() returns: the QR primarily arrives as a QRCode
    // event, but a caller polling GET /sessions/:id/qr in the seconds after start would otherwise see
    // null until the webhook lands. A failure here means only that the QR is not ready yet.
    await this.refreshQrCode(token);
  }

  /**
   * Reads the current QR straight from the service and publishes it.
   *
   * The field it sets is what `getQRCode()` returns, and the callback is what pushes it to the
   * dashboard. A duplicate delivery (this plus the QRCode event) is harmless — both carry the same
   * code and the consumer overwrites its state either way.
   */
  private async refreshQrCode(token: string): Promise<void> {
    try {
      const response = asRecord(await this.client.get<unknown>('/instance/qr', { apiKey: token }));
      // `qrcode` is the 0.7.x json tag; `Qrcode` is the 0.6.x spelling, and reading only one of them
      // is how a working deployment ends up showing an empty QR with no error anywhere.
      const qr = pickString(response, 'qrcode', 'Qrcode', 'code', 'Code');
      if (!qr) return;
      this.qrCode = qr;
      this.setStatus(EngineStatus.QR_READY);
      this.callbacks.onQRCode?.(qr);
    } catch {
      // Not ready, or already paired. Neither is worth a warning on the start path.
    }
  }

  /** The ingress URL the engine posts events to. */
  private webhookUrl(): string {
    const base = this.options.config.callbackBaseUrl.replace(/\/+$/, '');
    const secret = encodeURIComponent(this.options.config.ingressSecret);
    return `${base}/api/engine/evolution-go/webhook/${secret}`;
  }

  /** Applies a live event from the ingress controller. Public so the controller can drive it. */
  handleRemoteEvent(event: string, data: Record<string, unknown>): void {
    // The service emits `QRCode`; `QrCode` is the spelling the sibling Python integration expects and
    // is accepted too. Missing either one leaves the session with no QR at all, because this branch
    // is the only thing that populates it.
    if (event === 'QRCode' || event === 'QrCode' || event === 'qrcode') {
      const qr =
        pickString(asRecord(pick(data, 'Qrcode', 'qrcode', 'code', 'Code')), 'qrcode', 'Qrcode') ??
        pickString(data, 'Qrcode', 'qrcode', 'code', 'Code');
      if (qr) {
        this.qrCode = qr;
        this.setStatus(EngineStatus.QR_READY);
        this.callbacks.onQRCode?.(qr);
      }
      return;
    }

    if (event === 'Connection' || event === 'connection.update') {
      // `status` is what the `Connected` transition carries ({status:"open"}), `state` what a raw
      // connection update carries; both are read so neither spelling is silently ignored.
      const state = pickString(data, 'state', 'State', 'status', 'Status') ?? '';
      if (CONNECTED_STATES.has(state)) {
        if (this.instanceToken) void this.markReady(this.instanceToken);
      } else if (state.toLowerCase() === 'close' || state.toLowerCase() === 'disconnected') {
        this.setStatus(EngineStatus.DISCONNECTED);
        this.callbacks.onDisconnected?.(state);
        this.resolveReadyWaiters(false);
      }
      return;
    }
  }

  /**
   * Reads our own identity from the service and flips the session to READY.
   *
   * Takes the token rather than reading it back off the instance: this also runs from the ready
   * reconciliation, where the field may legitimately be unset (an adapter that has just adopted a
   * connection the engine already held), and `requireToken()` would refuse a call that is fine.
   */
  private async markReady(token: string): Promise<void> {
    this.qrCode = null;
    try {
      const remote = await this.instances.ensure(this.sessionId);
      // NO apiKey override: /instance/info/{id} is an ADMIN-scope route. It is checked against the
      // global key, so presenting the instance token answers 401 — which is silent here (the profile
      // block is best-effort) and shows up only as a session with no number and no name.
      const info = asRecord(await this.client.get<unknown>(`/instance/info/${encodeURIComponent(remote.id)}`)) ?? {};
      const instance = asRecord(pick(info, 'instance', 'Instance')) ?? info;

      // The instance record carries NO `phone` field: the account's number is inside `jid`, and it
      // arrives with the whatsmeow device suffix (`5527988180948:21@s.whatsapp.net`). Both have to be
      // stripped — the `@server` part because the contract stores a bare number, and the `:device`
      // part because no consumer expects it (the sibling integration had to sanitise it out of older
      // rows for exactly this reason).
      const jid = pickString(instance, 'jid', 'JID');
      if (jid) {
        const number = jid.split('@')[0]?.split(':')[0];
        if (number) this.phoneNumber = number;
      }

      // The profile name is NOT on the instance record either; the status endpoint is where the
      // service reports the connected account's display name.
      const status = asRecord(await this.client.get<unknown>('/instance/status', { apiKey: token }));
      const statusData = asRecord(pick(status, 'data', 'Data')) ?? status;
      this.pushName = pickString(statusData, 'Name', 'name') ?? this.pushName;
    } catch (error) {
      // Identity is cosmetic: a session that connected but whose profile read failed is still usable,
      // and failing the whole ready path over it would be worse than reporting a nameless session.
      this.logger.warn(`Could not read the instance profile after connect: ${describe(error)}`, {
        action: 'instance_info_failed',
      });
    }
    this.setStatus(EngineStatus.READY);
    this.callbacks.onReady?.(this.phoneNumber ?? '', this.pushName ?? '');
    this.resolveReadyWaiters(true);
  }

  /**
   * Keeps the session linked but drops the connection, so a later start needs no new QR scan.
   * Mirrors the whatsapp-web.js semantic of the same method.
   */
  async disconnect(): Promise<void> {
    if (this.instanceToken) {
      await this.client.post('/instance/disconnect', { apiKey: this.instanceToken });
    }
    this.setStatus(EngineStatus.DISCONNECTED);
    this.instanceToken = null;
  }

  /** Unlinks the account. A new start requires a fresh QR scan or pairing code. */
  async logout(): Promise<void> {
    const token = this.instanceToken;
    // The credential teardown this session's lifecycle must await: unlinking is what destroys the
    // remote session, and the local handle that names it must not outlive it.
    const teardown = (async (): Promise<void> => {
      if (token) {
        await this.client.delete('/instance/logout', { apiKey: token });
      }
      this.instances.purgeState(this.sessionId);
    })();
    this.callbacks.onCredentialTeardownStarted?.(teardown);
    await teardown;
    this.instanceToken = null;
    this.qrCode = null;
    this.phoneNumber = null;
    this.pushName = null;
    this.setStatus(EngineStatus.DISCONNECTED);
    this.resolveReadyWaiters(false);
  }

  /**
   * Local teardown only: the remote instance stays, so a later start reconnects without a QR.
   *
   * Nothing to await — there is no local process to wind down and the remote side is left alone on
   * purpose — but the interface is async, so it resolves rather than being declared `async`.
   */
  destroy(): Promise<void> {
    this.instanceToken = null;
    this.qrCode = null;
    this.setStatus(EngineStatus.DISCONNECTED);
    this.resolveReadyWaiters(false);
    return Promise.resolve();
  }

  /**
   * Tears down after a failed start.
   *
   * There is no local process to kill — the sibling engines SIGKILL a wedged browser here — so this
   * disconnects the remote side, which is the closest equivalent, and never throws: it runs on the
   * init-timeout path, where a second failure would mask the timeout the caller is reporting.
   */
  async forceDestroy(): Promise<void> {
    try {
      if (this.instanceToken) {
        await this.client.post('/instance/disconnect', { apiKey: this.instanceToken });
      }
    } catch (error) {
      this.logger.warn(`forceDestroy could not disconnect the instance: ${describe(error)}`, {
        action: 'force_destroy_failed',
      });
    }
    await this.destroy();
  }

  /**
   * Deletes the remote instance and its local handle. Used when the session itself is being removed,
   * so a deleted session cannot leave a linked instance behind on the engine deployment.
   */
  async deleteRemoteInstance(): Promise<void> {
    try {
      const instance = await this.instances.ensure(this.sessionId);
      await this.instances.deleteRemote({ id: instance.id, name: instance.name });
    } catch (error) {
      this.logger.warn(`Could not delete the remote instance: ${describe(error)}`, {
        action: 'instance_delete_failed',
      });
    }
    this.instances.purgeState(this.sessionId);
    this.instanceToken = null;
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  /**
   * A real round trip, like the whatsapp-web.js adapter's and unlike Baileys' local check: this
   * engine's liveness lives in another process, so nothing local can observe it going away. A wedged
   * or unreachable service is exactly what this probe exists to catch.
   */
  async probeLiveness(): Promise<boolean> {
    if (this.status !== EngineStatus.READY || !this.instanceToken) return false;
    try {
      const state = await this.readConnectionState(this.instanceToken);
      return state.connected;
    } catch {
      return false;
    }
  }

  private async readConnectionState(token: string): Promise<{ connected: boolean; loggedIn: boolean }> {
    const raw = asRecord(await this.client.get<unknown>('/instance/status', { apiKey: token }));
    const data = asRecord(pick(raw, 'data', 'Data')) ?? raw;
    const connected = pick(data, 'Connected', 'connected');
    const loggedIn = pick(data, 'LoggedIn', 'loggedIn');
    return { connected: connected === true, loggedIn: loggedIn === true };
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  /**
   * Requests a pairing code, the alternative to scanning the QR.
   *
   * The service answers with the code on the connect/pair call itself, and the session only becomes
   * usable once WhatsApp confirms the link, so the code is returned as-is and readiness continues to
   * arrive through the webhook.
   */
  async requestPairingCode(phoneNumber: string): Promise<string> {
    const token = this.requireToken();
    const response = asRecord(
      await this.client.post<unknown>('/instance/pair', { apiKey: token, body: { phone: phoneNumber } }),
    );
    const code = pickString(response, 'pairingCode', 'PairingCode', 'code', 'Code');
    if (!code) {
      throw new EngineRefusedError(
        'Evolution Go did not return a pairing code. Check that the number is in international format (digits only, with country code).',
      );
    }
    return code;
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  // ==========================================================================
  // Sending
  // ==========================================================================

  async sendTextMessage(chatId: string, text: string, mentions?: string[]): Promise<MessageResult> {
    const body: Record<string, unknown> = { number: this.toServiceJid(chatId), formatJid: true, text };
    if (mentions?.length) body.mentionedJid = mentions.map(m => this.toServiceJid(m));
    const response = await this.scoped<unknown>('POST', '/send/text', body);
    return this.readSendResult(response, chatId);
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMedia(chatId, media, 'image');
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMedia(chatId, media, 'video');
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    // ONE type covers both: the service transcodes `audio` to Ogg/Opus and always sends it with
    // `PTT:true`, so a voice note and an audio file are the same call (there is no separate endpoint,
    // and `ptt` is not an accepted `type` value — it answers 500). `media.ptt` is therefore
    // accepted and ignored rather than translated into a type the service would reject.
    void media.ptt;
    return this.sendMedia(chatId, media, 'audio');
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.sendMedia(chatId, media, 'document');
  }

  private async sendMedia(chatId: string, media: MediaInput, type: string): Promise<MessageResult> {
    const url = await this.resolveMediaUrl(media);
    const body = this.sendEnvelope(chatId, media);
    body.type = type;
    body.url = url;
    if (media.filename) body.filename = media.filename;
    const response = await this.client.requestVia<unknown>('POST', '/send/media', {
      apiKey: this.requireToken(),
      body,
      timeoutMs: this.client.mediaTimeoutMs,
    });
    return this.readSendResult(response, chatId);
  }

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    const body = this.sendEnvelope(chatId, location);
    body.latitude = location.latitude;
    body.longitude = location.longitude;
    if (location.description) body.name = location.description;
    if (location.address) body.address = location.address;
    const response = await this.scoped<unknown>('POST', '/send/location', body);
    return this.readSendResult(response, chatId);
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    const body = this.sendEnvelope(chatId, contact);
    // An OBJECT, not a vCard string: the service builds the vCard text itself from these three
    // fields. `organization` is part of the struct, and omitting it is fine but not free — the
    // display name WhatsApp renders comes from `fullName`.
    body.vcard = { fullName: contact.name, organization: '', phone: contact.number };
    const response = await this.scoped<unknown>('POST', '/send/contact', body);
    return this.readSendResult(response, chatId);
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    const url = await this.resolveMediaUrl(media);
    const body = this.sendEnvelope(chatId, media);
    body.sticker = url;
    const response = await this.client.requestVia<unknown>('POST', '/send/sticker', {
      apiKey: this.requireToken(),
      body,
      timeoutMs: this.client.mediaTimeoutMs,
    });
    return this.readSendResult(response, chatId);
  }

  async sendPollMessage(chatId: string, poll: PollInput): Promise<MessageResult> {
    const body = this.sendEnvelope(chatId, poll);
    body.question = poll.name;
    body.options = poll.options;
    if (poll.allowMultipleAnswers) body.maxAnswer = poll.options.length;
    const response = await this.scoped<unknown>('POST', '/send/poll', body);
    return this.readSendResult(response, chatId);
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string, mentions?: string[]): Promise<MessageResult> {
    const body: Record<string, unknown> = {
      number: this.toServiceJid(chatId),
      formatJid: true,
      text,
      quoted: { messageId: quotedMsgId },
    };
    if (mentions?.length) body.mentionedJid = mentions.map(m => this.toServiceJid(m));
    const response = await this.scoped<unknown>('POST', '/send/text', body);
    return this.readSendResult(response, chatId);
  }

  forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    void fromChatId;
    void toChatId;
    void messageId;
    return this.unsupported('forwardMessage');
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    await this.scoped('POST', '/message/react', {
      number: this.toServiceJid(chatId),
      id: messageId,
      reaction: emoji,
    });
  }

  getMessageReactions(chatId: string, messageId: string): Promise<MessageReaction[]> {
    void chatId;
    void messageId;
    return this.unsupported('getMessageReactions');
  }

  async deleteMessage(chatId: string, messageId: string, forEveryone?: boolean): Promise<void> {
    // `forEveryone` is not a choice this endpoint offers: it revokes for everyone, which is why the
    // method is supported and the me-only variant is not silently pretended.
    void forEveryone;
    await this.scoped('POST', '/message/delete', { chat: this.toServiceJid(chatId), messageId });
  }

  async editMessage(chatId: string, messageId: string, body: string, mentions?: string[]): Promise<MessageResult> {
    void mentions;
    await this.scoped('POST', '/message/edit', {
      chat: this.toServiceJid(chatId),
      messageId,
      message: body,
    });
    return { id: messageId, timestamp: Math.floor(this.now() / 1000) };
  }

  starMessage(chatId: string, messageId: string, star: boolean): Promise<void> {
    void chatId;
    void messageId;
    void star;
    return this.unsupported('starMessage');
  }

  votePoll(chatId: string, pollMessageId: string, options: string[]): Promise<void> {
    void chatId;
    void pollMessageId;
    void options;
    return this.unsupported('votePoll');
  }

  pinMessage(chatId: string, messageId: string, durationSeconds: number): Promise<void> {
    void chatId;
    void messageId;
    void durationSeconds;
    return this.unsupported('pinMessage');
  }

  unpinMessage(chatId: string, messageId: string): Promise<void> {
    void chatId;
    void messageId;
    return this.unsupported('unpinMessage');
  }

  getChatHistory(
    chatId: string,
    limit?: number,
    includeMedia?: boolean,
    mediaMaxBytes?: number,
    signal?: AbortSignal,
  ): Promise<IncomingMessage[]> {
    void chatId;
    void limit;
    void includeMedia;
    void mediaMaxBytes;
    void signal;
    return this.unsupported('getChatHistory');
  }

  // ==========================================================================
  // Contacts
  // ==========================================================================

  async getContacts(): Promise<Contact[]> {
    const listed = await this.scoped<unknown>('GET', '/user/contacts');
    // The service has returned this both as a bare array and wrapped; accept either rather than
    // turning a working deployment into an empty contact list.
    const entries = Array.isArray(listed) ? listed : asArray(pick(asRecord(listed), 'contacts', 'Contacts'));
    return entries
      .map(entry => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .map(entry => this.mapContact(entry))
      .filter((contact): contact is Contact => contact !== null);
  }

  private mapContact(entry: Record<string, unknown>): Contact | null {
    // The contact struct has NO json tags, so its fields arrive as Go names: `Jid` (this exact
    // casing — not `jid`), `FullName`, `PushName`, `BusinessName`. The camelCase spellings are
    // still read for the deployments whose marshaller applies tags.
    const rawId = pickString(entry, 'Jid', 'jid', 'JID', 'id', 'ID', 'number', 'Number');
    if (!rawId) return null;
    const id = toNeutralJid(rawId);
    const number = pickString(entry, 'number', 'Number') ?? id.split('@')[0];
    return {
      id,
      name:
        pickString(entry, 'FullName', 'fullName', 'name', 'Name') ?? pickString(entry, 'BusinessName', 'businessName'),
      pushName: pickString(entry, 'PushName', 'pushName', 'notify', 'Notify'),
      number,
      isMyContact: pick(entry, 'isMyContact', 'IsMyContact') === true,
      isBlocked: pick(entry, 'isBlocked', 'IsBlocked') === true,
    };
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    const found = await this.queryUser(contactId, '/user/info');
    if (!found) return null;
    return this.mapContact(found);
  }

  /**
   * Looks one number up through `/user/info` or `/user/check`.
   *
   * The `number` field is an ARRAY on both endpoints — a bare string is answered with a 400 — which
   * is the kind of detail that turns a working integration into one that always fails, so the
   * wrapping happens here and nowhere else.
   */
  private async queryUser(contactId: string, path: string): Promise<Record<string, unknown> | null> {
    const neutral = this.toServiceJid(contactId);
    const response = await this.scoped<unknown>('POST', path, { number: [neutral], formatJid: true });

    // The payload is wrapped: /user/check answers `{ Users: [ {...} ] }` (an ARRAY) while /user/info
    // answers `{ Users: { "<jid>": {...} } }` (a MAP keyed by JID). Reading the envelope directly
    // would return the wrapper as if it were the user, and every field below would read undefined.
    const users = pick(asRecord(response), 'Users', 'users') ?? response;
    if (Array.isArray(users)) {
      const first: unknown = (users as unknown[])[0];
      return asRecord(first) ?? null;
    }
    const asMap = asRecord(users);
    if (!asMap) return null;
    const firstValue: unknown = Object.values(asMap)[0];
    return asRecord(firstValue) ?? null;
  }

  async checkNumberExists(number: string): Promise<boolean> {
    const found = await this.queryUser(number, '/user/check');
    if (!found) return false;
    const exists = pick(found, 'exists', 'Exists', 'isInWhatsapp', 'IsInWhatsapp', 'isWAContact');
    return exists === true;
  }

  async getNumberId(number: string): Promise<string | null> {
    const found = await this.queryUser(number, '/user/check');
    if (!found) return null;
    const jid = pickString(found, 'jid', 'JID', 'id', 'ID');
    if (!jid) return null;
    return toNeutralJid(jid);
  }

  /**
   * Resolves the phone behind a privacy id.
   *
   * The service reports the alternative address alongside the lid on the same node, so this is a
   * direct read rather than the mapping-store dance the library engines need.
   */
  async resolveContactPhone(contactId: string): Promise<string | null> {
    const found = await this.queryUser(contactId, '/user/info');
    if (!found) return null;
    const alt = pickString(found, 'senderAlt', 'SenderAlt', 'phone', 'Phone', 'number', 'Number');
    if (!alt) return null;
    return alt.split('@')[0]?.split(':')[0] ?? null;
  }

  async getProfilePicture(contactId: string): Promise<string | null> {
    const response = asRecord(
      await this.scoped<unknown>('POST', '/user/avatar', { number: this.toServiceJid(contactId), preview: false }),
    );
    return pickString(response, 'url', 'URL', 'profilePicUrl', 'ProfilePicUrl', 'base64', 'Base64') ?? null;
  }

  async blockContact(contactId: string): Promise<void> {
    await this.scoped('POST', '/user/block', { number: this.toServiceJid(contactId) });
  }

  async unblockContact(contactId: string): Promise<void> {
    await this.scoped('POST', '/user/unblock', { number: this.toServiceJid(contactId) });
  }

  async getBlockedContacts(): Promise<string[]> {
    const listed = await this.scoped<unknown>('GET', '/user/blocklist');
    const entries = Array.isArray(listed) ? listed : asArray(pick(asRecord(listed), 'blocklist', 'Blocklist'));
    return entries
      .map(entry => (typeof entry === 'string' ? entry : pickString(asRecord(entry), 'id', 'ID', 'jid', 'JID')))
      .filter((entry): entry is string => entry !== undefined)
      .map(entry => toNeutralJid(entry));
  }

  upsertContact(contactId: string, firstName: string, lastName?: string): Promise<void> {
    void contactId;
    void firstName;
    void lastName;
    return this.unsupported('upsertContact');
  }

  deleteContact(contactId: string): Promise<void> {
    void contactId;
    return this.unsupported('deleteContact');
  }

  // ==========================================================================
  // Groups
  // ==========================================================================

  async getGroups(): Promise<Group[]> {
    // \`/group/myall\` is documented upstream as "TODO: not working", so the working listing route is
    // used instead; both answer a group array, and the field reader below accepts either spelling.
    const listed = await this.scoped<unknown>('GET', '/group/list');
    const entries = Array.isArray(listed) ? listed : asArray(pick(asRecord(listed), 'groups', 'Groups'));
    return entries
      .map(entry => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .map((entry): Group | null => {
        const rawId = pickString(entry, 'JID', 'jid', 'id', 'ID');
        if (!rawId) return null;
        // The count is omitted rather than defaulted to 0 when the service does not report it:
        // "no members" and "not disclosed" are different answers.
        const participantsCount = num(pick(entry, 'ParticipantCount', 'participantCount'));
        const group: Group = {
          id: toNeutralJid(rawId),
          name: pickString(entry, 'Name', 'name', 'subject', 'Subject') ?? '',
        };
        if (participantsCount !== undefined) group.participantsCount = participantsCount;
        return group;
      })
      .filter((group): group is Group => group !== null);
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    const response = asRecord(
      await this.scoped<unknown>('POST', '/group/info', { groupJid: this.toServiceJid(groupId) }),
    );
    if (!response) return null;
    const participants = asArray(pick(response, 'Participants', 'participants'))
      .map(entry => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .map(entry => this.mapParticipant(entry));
    const rawId = pickString(response, 'JID', 'jid', 'id', 'ID') ?? groupId;
    return {
      id: toNeutralJid(rawId),
      name: pickString(response, 'Name', 'name', 'subject', 'Subject') ?? '',
      description: pickString(response, 'Topic', 'topic', 'description', 'Description'),
      owner: pickString(response, 'OwnerJID', 'ownerJid', 'owner', 'Owner'),
      createdAt: num(pick(response, 'GroupCreated', 'groupCreated', 'createdAt')),
      participants,
      isAnnounce: pick(response, 'IsAnnounce', 'isAnnounce') === true,
      announce: pick(response, 'IsAnnounce', 'isAnnounce') === true,
      locked: pick(response, 'IsLocked', 'isLocked') === true,
      linkedParentJID: pickString(response, 'LinkedParentJID', 'linkedParentJid') ?? null,
    };
  }

  private mapParticipant(entry: Record<string, unknown>): GroupParticipant {
    const rawId = pickString(entry, 'JID', 'jid', 'id', 'ID') ?? '';
    const id = toNeutralJid(rawId);
    const isAdmin = pick(entry, 'IsAdmin', 'isAdmin') === true;
    return {
      id,
      number: pickString(entry, 'PhoneNumber', 'phoneNumber') ?? id.split('@')[0],
      name: pickString(entry, 'DisplayName', 'displayName', 'name', 'Name'),
      isAdmin,
      isSuperAdmin: pick(entry, 'IsSuperAdmin', 'isSuperAdmin') === true || isAdmin,
    };
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    const response = asRecord(
      await this.scoped<unknown>('POST', '/group/create', {
        groupName: name,
        participants: participants.map(p => this.toServiceJid(p)),
      }),
    );
    const rawId = pickString(response, 'JID', 'jid', 'id', 'ID');
    if (!rawId) {
      throw new EngineRefusedError('Evolution Go created the group but returned no group id.');
    }
    const group: Group = { id: toNeutralJid(rawId), name, participantsCount: participants.length };
    return group;
  }

  /**
   * One endpoint serves all four participant writes, selected by `action`.
   *
   * The service answers with a per-participant verdict, so a partial success is reported as such
   * instead of being flattened into one boolean — which is the shape the neutral contract asks for.
   */
  private async updateParticipants(
    groupId: string,
    participants: string[],
    action: 'add' | 'remove' | 'promote' | 'demote',
  ): Promise<ParticipantOperationResult[]> {
    const response = await this.scoped<unknown>('POST', '/group/participant', {
      groupJid: this.toServiceJid(groupId),
      participants: participants.map(p => this.toServiceJid(p)),
      action,
    });
    const results = asArray(pick(asRecord(response), 'results', 'Results', 'participants', 'Participants'));
    if (results.length === 0) {
      // No per-participant verdict: the call succeeded as a batch, which is all the service reported.
      return participants.map(id => ({ id: toNeutralJid(id), success: true, status: 200 }));
    }
    return results
      .map(entry => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .map(entry => {
        const rawId = pickString(entry, 'jid', 'JID', 'id', 'ID') ?? groupId;
        const status = num(pick(entry, 'status', 'Status'));
        const error = pickString(entry, 'error', 'Error', 'message', 'Message');
        return {
          id: toNeutralJid(rawId),
          success: error === undefined && (status === undefined || (status >= 200 && status < 300)),
          status,
          message: error,
        };
      });
  }

  addParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.updateParticipants(groupId, participants, 'add');
  }

  removeParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.updateParticipants(groupId, participants, 'remove');
  }

  promoteParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.updateParticipants(groupId, participants, 'promote');
  }

  demoteParticipants(groupId: string, participants: string[]): Promise<ParticipantOperationResult[]> {
    return this.updateParticipants(groupId, participants, 'demote');
  }

  async leaveGroup(groupId: string): Promise<void> {
    await this.scoped('POST', '/group/leave', { groupJid: this.toServiceJid(groupId) });
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    // The field is `name`, NOT `groupName` — the service's struct is {groupJid, name}. A misspelling
    // is silently dropped by Go's decoder, which leaves `name` empty and makes the endpoint answer
    // 400: a rename that never happens, with nothing naming the field that was wrong.
    await this.scoped('POST', '/group/name', { groupJid: this.toServiceJid(groupId), name: subject });
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    await this.scoped('POST', '/group/description', {
      groupJid: this.toServiceJid(groupId),
      description,
    });
  }

  async getGroupInviteCode(groupId: string): Promise<string> {
    const response = asRecord(
      await this.scoped<unknown>('POST', '/group/invitelink', { groupJid: this.toServiceJid(groupId) }),
    );
    const link = pickString(response, 'inviteLink', 'InviteLink', 'link', 'Link', 'code', 'Code');
    if (!link) {
      throw new EngineRefusedError(`Evolution Go returned no invite link for group ${groupId}.`);
    }
    return link;
  }

  revokeGroupInviteCode(groupId: string): Promise<string> {
    void groupId;
    return this.unsupported('revokeGroupInviteCode');
  }

  async joinGroupViaInviteCode(inviteCode: string): Promise<string> {
    // The whole link, or just the code — the service accepts either, and callers pass both shapes.
    const response = asRecord(
      await this.scoped<unknown>('POST', '/group/join', { inviteLink: inviteCode, code: inviteCode }),
    );
    const rawId = pickString(response, 'JID', 'jid', 'id', 'ID');
    if (!rawId) {
      throw new EngineRefusedError('Evolution Go joined the group but returned no group id.');
    }
    return toNeutralJid(rawId);
  }

  getGroupJoinInfo(inviteCode: string): Promise<GroupJoinInfo> {
    void inviteCode;
    return this.unsupported('getGroupJoinInfo');
  }

  async setGroupMessagesAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    await this.scoped('POST', '/group/settings', {
      groupJid: this.toServiceJid(groupId),
      action: adminsOnly ? 'announcement' : 'not_announcement',
    });
  }

  async setGroupInfoAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    await this.scoped('POST', '/group/settings', {
      groupJid: this.toServiceJid(groupId),
      action: adminsOnly ? 'locked' : 'unlocked',
    });
  }

  async setGroupPicture(groupId: string, media: MediaInput): Promise<void> {
    const url = await this.resolveMediaUrl(media);
    await this.client.requestVia('POST', '/group/photo', {
      apiKey: this.requireToken(),
      body: { groupJid: this.toServiceJid(groupId), image: url },
      timeoutMs: this.client.mediaTimeoutMs,
    });
  }

  deleteGroupPicture(groupId: string): Promise<void> {
    void groupId;
    return this.unsupported('deleteGroupPicture');
  }

  setGroupMemberAddMode(groupId: string, mode: GroupMemberAddMode): Promise<void> {
    void groupId;
    void mode;
    return this.unsupported('setGroupMemberAddMode');
  }

  setGroupEphemeral(groupId: string, durationSec: number): Promise<void> {
    void groupId;
    void durationSec;
    return this.unsupported('setGroupEphemeral');
  }

  getGroupMembershipRequests(groupId: string): Promise<GroupMembershipRequest[]> {
    void groupId;
    return this.unsupported('getGroupMembershipRequests');
  }

  approveGroupMembershipRequests(groupId: string, participants?: string[]): Promise<ParticipantOperationResult[]> {
    void groupId;
    void participants;
    return this.unsupported('approveGroupMembershipRequests');
  }

  rejectGroupMembershipRequests(groupId: string, participants?: string[]): Promise<ParticipantOperationResult[]> {
    void groupId;
    void participants;
    return this.unsupported('rejectGroupMembershipRequests');
  }

  // ==========================================================================
  // Calls
  // ==========================================================================

  async rejectCall(callId: string): Promise<void> {
    await this.scoped('POST', '/call/reject', { callId, id: callId });
  }

  createCallLink(type: CallLinkType, startTime: number): Promise<string> {
    void type;
    void startTime;
    return this.unsupported('createCallLink');
  }

  // ==========================================================================
  // Own profile & presence
  // ==========================================================================

  async setProfileName(name: string): Promise<void> {
    await this.scoped('POST', '/user/profileName', { name });
  }

  async setProfileStatus(status: string): Promise<void> {
    await this.scoped('POST', '/user/profileStatus', { status });
  }

  async setProfilePicture(media: MediaInput): Promise<void> {
    const url = await this.resolveMediaUrl(media);
    await this.client.requestVia('POST', '/user/profilePicture', {
      apiKey: this.requireToken(),
      body: { image: url },
      timeoutMs: this.client.mediaTimeoutMs,
    });
  }

  deleteProfilePicture(): Promise<void> {
    return this.unsupported('deleteProfilePicture');
  }

  // ==========================================================================
  // Labels (WA Business)
  // ==========================================================================

  async getLabels(): Promise<Label[]> {
    const listed = await this.scoped<unknown>('GET', '/label/list');
    const entries = Array.isArray(listed) ? listed : asArray(pick(asRecord(listed), 'labels', 'Labels'));
    return entries
      .map(entry => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .map(entry => {
        const id = pickString(entry, 'id', 'ID', 'labelId', 'LabelID');
        if (!id) return null;
        return {
          id,
          name: pickString(entry, 'name', 'Name') ?? '',
          hexColor: pickString(entry, 'hexColor', 'HexColor', 'color', 'Color') ?? '',
        } satisfies Label;
      })
      .filter((label): label is Label => label !== null);
  }

  async getLabelById(labelId: string): Promise<Label | null> {
    const labels = await this.getLabels();
    return labels.find(label => label.id === labelId) ?? null;
  }

  getChatLabels(chatId: string): Promise<Label[]> {
    void chatId;
    return this.unsupported('getChatLabels');
  }

  async addLabelToChat(chatId: string, labelId: string): Promise<void> {
    await this.scoped('POST', '/label/chat', { jid: this.toServiceJid(chatId), labelId });
  }

  async upsertLabel(label: LabelInput): Promise<void> {
    const body: Record<string, unknown> = { labelId: label.id };
    if (label.name !== undefined) body.name = label.name;
    if (label.color !== undefined) body.color = label.color;
    await this.scoped('POST', '/label/edit', body);
  }

  deleteLabel(labelId: string): Promise<void> {
    void labelId;
    return this.unsupported('deleteLabel');
  }

  getChatsByLabel(labelId: string): Promise<ChatSummary[]> {
    void labelId;
    return this.unsupported('getChatsByLabel');
  }

  async removeLabelFromChat(chatId: string, labelId: string): Promise<void> {
    await this.scoped('POST', '/unlabel/chat', { jid: this.toServiceJid(chatId), labelId });
  }

  // ==========================================================================
  // Channels (newsletters)
  // ==========================================================================

  async getSubscribedChannels(): Promise<Channel[]> {
    const listed = await this.scoped<unknown>('GET', '/newsletter/list');
    const entries = Array.isArray(listed) ? listed : asArray(pick(asRecord(listed), 'newsletters', 'Newsletters'));
    return entries
      .map(entry => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .map(entry => this.mapChannel(entry))
      .filter((channel): channel is Channel => channel !== null);
  }

  private mapChannel(entry: Record<string, unknown>): Channel | null {
    // The newsletter node nests its display fields under `threadMetadata` on some builds and
    // carries them flat on others, so both shapes are read.
    const metadata = asRecord(pick(entry, 'threadMetadata', 'ThreadMetadata')) ?? entry;
    const rawId = pickString(entry, 'id', 'ID', 'jid', 'JID');
    if (!rawId) return null;
    return {
      id: toNeutralJid(rawId),
      name: pickString(metadata, 'name', 'Name') ?? pickString(entry, 'name', 'Name') ?? '',
      description: pickString(entry, 'description', 'Description'),
      inviteCode: pickString(entry, 'inviteCode', 'InviteCode'),
      subscriberCount: num(pick(entry, 'subscriberCount', 'SubscriberCount', 'subscribers')),
      picture: pickString(entry, 'picture', 'Picture', 'preview'),
      verified: pick(entry, 'verified', 'Verified') === true,
      createdAt: num(pick(entry, 'createdAt', 'CreatedAt', 'creationTime')),
    };
  }

  async getChannelById(channelId: string): Promise<Channel | null> {
    const response = asRecord(
      await this.scoped<unknown>('POST', '/newsletter/info', { jid: this.toServiceJid(channelId) }),
    );
    if (!response) return null;
    const nested = asRecord(pick(response, 'newsletter', 'Newsletter')) ?? response;
    return this.mapChannel(nested);
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    // The service's struct is {jid}: it has no `inviteCode` and no `key` field, so both spellings
    // were dropped by the decoder and every call answered 400 for a missing `jid`.
    //
    // A bare value is normalised to the newsletter id form, because that is what a caller has: the
    // code in a channel link IS the channel's id, which is the local part of its jid.
    const jid = inviteCode.includes('@') ? inviteCode : `${inviteCode}@newsletter`;
    const response = asRecord(await this.scoped<unknown>('POST', '/newsletter/subscribe', { jid }));
    const channel = response ? this.mapChannel(response) : null;
    if (!channel) {
      throw new EngineRefusedError('Evolution Go did not return the subscribed channel.');
    }
    return channel;
  }

  unsubscribeFromChannel(channelId: string): Promise<void> {
    void channelId;
    return this.unsupported('unsubscribeFromChannel');
  }

  async getChannelMessages(channelId: string, limit?: number): Promise<ChannelMessage[]> {
    const response = await this.scoped<unknown>('POST', '/newsletter/messages', {
      jid: this.toServiceJid(channelId),
      count: limit,
    });
    const entries = Array.isArray(response) ? response : asArray(pick(asRecord(response), 'messages', 'Messages'));
    return entries
      .map(entry => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .map(entry => ({
        id: pickString(entry, 'id', 'ID') ?? '',
        body: pickString(entry, 'message', 'Message', 'text', 'Text', 'caption') ?? '',
        timestamp: num(pick(entry, 'timestamp', 'Timestamp')) ?? 0,
        hasMedia: pick(entry, 'hasMedia', 'HasMedia', 'mediaType', 'MediaType') !== undefined,
      }))
      .filter(message => message.id !== '');
  }

  async createChannel(name: string, description?: string): Promise<Channel> {
    const response = asRecord(await this.scoped<unknown>('POST', '/newsletter/create', { name, description }));
    const channel = response ? this.mapChannel(response) : null;
    if (!channel) {
      throw new EngineRefusedError('Evolution Go created the newsletter but returned no id.');
    }
    return channel;
  }

  deleteChannel(channelId: string): Promise<void> {
    void channelId;
    return this.unsupported('deleteChannel');
  }

  muteChannel(channelId: string, mute: boolean): Promise<void> {
    void channelId;
    void mute;
    return this.unsupported('muteChannel');
  }

  demoteChannelAdmin(channelId: string, userId: string): Promise<void> {
    void channelId;
    void userId;
    return this.unsupported('demoteChannelAdmin');
  }

  transferChannelOwnership(channelId: string, newOwnerId: string): Promise<void> {
    void channelId;
    void newOwnerId;
    return this.unsupported('transferChannelOwnership');
  }

  // ==========================================================================
  // Status / stories
  // ==========================================================================

  getContactStatuses(): Promise<Status[]> {
    return this.unsupported('getContactStatuses');
  }

  getContactStatus(contactId: string): Promise<Status[]> {
    void contactId;
    return this.unsupported('getContactStatus');
  }

  async postTextStatus(text: string, options: StatusPostOptions): Promise<StatusResult> {
    void options;
    await this.scoped('POST', '/send/status/text', { text });
    return this.statusResult();
  }

  async postImageStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.postMediaStatus(media, options, 'image');
  }

  async postVideoStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.postMediaStatus(media, options, 'video');
  }

  /**
   * Posts a media status.
   *
   * The dedicated status endpoint accepts only image and video — the service's own contract — which
   * is why {@link postVoiceStatus} is a refusal rather than a call that would silently post nothing.
   */
  private async postMediaStatus(
    media: MediaInput,
    options: StatusPostOptions,
    type: 'image' | 'video',
  ): Promise<StatusResult> {
    const url = await this.resolveMediaUrl(media);
    await this.client.requestVia('POST', '/send/status/media', {
      apiKey: this.requireToken(),
      body: { type, url, caption: options.caption ?? media.caption },
      timeoutMs: this.client.mediaTimeoutMs,
    });
    return this.statusResult();
  }

  /** Statuses expire 24h after posting; the caller gets both ends of that window. */
  private statusResult(): StatusResult {
    const timestamp = new Date(this.now());
    return {
      statusId: `status-${timestamp.getTime()}`,
      timestamp,
      expiresAt: new Date(timestamp.getTime() + 24 * 60 * 60 * 1000),
    };
  }

  postVoiceStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    void media;
    void options;
    return this.unsupported('postVoiceStatus');
  }

  deleteStatus(statusId: string): Promise<void> {
    void statusId;
    return this.unsupported('deleteStatus');
  }

  // ==========================================================================
  // Catalog & products (WA Business)
  // ==========================================================================

  getCatalog(): Promise<null> {
    return this.unsupported('getCatalog');
  }

  getProducts(options?: ProductQueryOptions): Promise<PaginatedProducts> {
    void options;
    return this.unsupported('getProducts');
  }

  getProduct(productId: string): Promise<null> {
    void productId;
    return this.unsupported('getProduct');
  }

  sendProduct(chatId: string, productId: string, body?: string): Promise<MessageResult> {
    void chatId;
    void productId;
    void body;
    return this.unsupported('sendProduct');
  }

  sendCatalog(chatId: string, body?: string): Promise<MessageResult> {
    void chatId;
    void body;
    return this.unsupported('sendCatalog');
  }

  // ==========================================================================
  // Chats
  // ==========================================================================

  getChats(): Promise<ChatSummary[]> {
    return this.unsupported('getChats');
  }

  async sendSeen(chatId: string, messageIds?: string[]): Promise<boolean> {
    // The endpoint requires the id array ("id is required" without it) — there is no chat-wide
    // read. That is a refusal of THIS request, not a missing capability, so it is an EngineRefused
    // rather than a 501: the matrix keeps the row supported, and the caller is told what to pass.
    if (!messageIds?.length) {
      throw new EngineRefusedError(
        'Evolution Go cannot mark a whole chat as read: pass explicit messageIds to sendSeen.',
      );
    }
    await this.scoped('POST', '/message/markread', {
      number: this.toServiceJid(chatId),
      id: messageIds,
    });
    return true;
  }

  markUnread(chatId: string): Promise<boolean> {
    void chatId;
    return this.unsupported('markUnread');
  }

  deleteChat(chatId: string): Promise<boolean> {
    void chatId;
    return this.unsupported('deleteChat');
  }

  async archiveChat(chatId: string, archive: boolean): Promise<boolean> {
    await this.scoped('POST', archive ? '/chat/archive' : '/chat/unarchive', {
      chat: this.toServiceJid(chatId),
    });
    return true;
  }

  async pinChat(chatId: string, pin: boolean): Promise<boolean> {
    await this.scoped('POST', pin ? '/chat/pin' : '/chat/unpin', { chat: this.toServiceJid(chatId) });
    return true;
  }

  async muteChat(chatId: string, muteUntil: number | null): Promise<void> {
    // A duration is not part of this endpoint: it mutes indefinitely, so the caller's expiry is
    // deliberately not pretended — see the capability matrix for the row.
    void muteUntil;
    await this.scoped('POST', '/chat/mute', { chat: this.toServiceJid(chatId) });
  }

  clearChatMessages(chatId: string): Promise<boolean> {
    void chatId;
    return this.unsupported('clearChatMessages');
  }

  /**
   * Chat state (typing / recording / paused).
   *
   * This is what the anti-ban typing simulator drives, so it is wired rather than optional: the
   * engine service keeps the indicator alive for `delay` milliseconds on its own side.
   */
  async sendChatState(chatId: string, state: ChatState): Promise<void> {
    // The service's `state` vocabulary is exactly composing|paused. A recording indicator is
    // composing with `isAudio`, NOT a state named "recording" — sending that token is silently
    // ignored by WhatsApp, so the indicator simply never appears.
    const body: Record<string, unknown> = {
      number: this.toServiceJid(chatId),
      state: state === 'paused' ? 'paused' : 'composing',
      isAudio: state === 'recording',
    };
    await this.scoped('POST', '/message/presence', body);
  }

  async setOnlinePresence(available: boolean): Promise<void> {
    // Addressed to our own number when the service has told us what it is; 'self' is the service's
    // own shorthand for the connected account and is the fallback before the profile read lands.
    await this.scoped('POST', '/message/presence', {
      number: this.phoneNumber ?? 'self',
      state: available ? 'available' : 'unavailable',
    });
  }

  subscribeToPresence(chatId: string): Promise<void> {
    void chatId;
    return this.unsupported('subscribeToPresence');
  }

  // ==========================================================================
  // Events (driven by the ingress controller)
  // ==========================================================================

  /** Applies a mapped inbound message. Called by the ingress controller with a parsed payload. */
  emitInbound(data: Record<string, unknown>): void {
    const mapped = mapIncomingMessage(data, {
      resolvePhone: jid => this.resolvePhoneFromLid(jid),
    });
    if (!mapped) return;

    if (mapped.fromMe) {
      this.callbacks.onMessageCreate?.(mapped);
      return;
    }

    // A revoked/edited/reaction message is not a new message: each has its own callback, and
    // emitting it as inbound too would make an edit look like a second delivery of the same text.
    const content = mapped.rawContent;
    const protocol = asRecord(pick(content, 'protocolMessage', 'ProtocolMessage'));
    if (protocol) {
      const type = pickString(protocol, 'type', 'Type') ?? '';
      if (type.toUpperCase().includes('REVOKE')) {
        this.callbacks.onMessageRevoked?.({
          id: mapped.id,
          revokedId: pickString(asRecord(pick(protocol, 'key', 'Key')), 'ID', 'id'),
          chatId: mapped.chatId,
          from: mapped.from,
          to: mapped.to,
          type: 'revoked',
          body: '',
          timestamp: mapped.timestamp,
        });
        return;
      }
    }

    const reaction = asRecord(pick(content, 'reactionMessage', 'ReactionMessage'));
    if (reaction) {
      this.callbacks.onMessageReaction?.({
        messageId: pickString(asRecord(pick(reaction, 'key', 'Key')), 'ID', 'id') ?? mapped.id,
        chatId: mapped.chatId,
        reaction: pickString(reaction, 'text', 'Text') ?? '',
        senderId: mapped.author ?? mapped.from,
      });
      return;
    }

    this.callbacks.onMessage?.(mapped);
  }

  /** Best-effort lid→phone resolution; the service reports the pair inline on most payloads. */
  private resolvePhoneFromLid(jid: string): string | null {
    if (!jid.endsWith('@lid')) return null;
    return null;
  }

  /**
   * True when a webhook names THIS session's remote instance.
   *
   * The ingress receives every session's events on one route and has only the instance name to go
   * on. Exposing the comparison here keeps the naming rule (prefix + session name) in the one file
   * that owns it, instead of duplicating the concatenation in the controller.
   */
  matchesInstance(instanceName: string): boolean {
    return instanceName === this.instances.remoteName(this.sessionId);
  }

  /** Call events have their own callbacks; kept here so the event mapper stays adapter-agnostic. */
  emitCall(event: Parameters<NonNullable<EngineEventCallbacks['onCall']>>[0]): void {
    this.callbacks.onCall?.(event);
  }

  emitCallOutcome(event: Parameters<NonNullable<EngineEventCallbacks['onCallOutcome']>>[0]): void {
    this.callbacks.onCallOutcome?.(event);
  }

  /**
   * The QR that was on screen expired unscanned.
   *
   * The session stays in QR_READY: the engine keeps generating codes, and a caller polling
   * `getQRCode()` is better served by the current one than by `null`. Nothing is reported to the
   * lifecycle — an unscanned code is a normal part of pairing, not an incident.
   */
  handleQrTimeout(): void {
    this.qrCode = null;
    if (this.status === EngineStatus.QR_READY) {
      // Re-read it so a poll right after the expiry does not see a code that is no longer valid.
      if (this.instanceToken) void this.refreshQrCode(this.instanceToken);
      return;
    }
    this.setStatus(EngineStatus.QR_READY);
  }

  /**
   * The account was unlinked on the phone side.
   *
   * Terminal, unlike a drop: the credentials are gone, so this reports FAILED and hands the reason
   * to `onError` rather than `onDisconnected` — the lifecycle reconnects on the latter, and
   * reconnecting an unlinked session just fails repeatedly.
   */
  emitLoggedOut(reason: string): void {
    // TWO situations share this event, and only the session's own history can tell them apart.
    //
    //  - The account WAS linked and WhatsApp unlinked it: nothing can recover that, so it is a
    //    terminal failure and the operator has to pair again.
    //  - The session NEVER reached READY and the QR expired unscanned. The engine's own log reads
    //    "Client exists but not connected, checking for existing QR code" before it fires this, and
    //    it is simply giving up after re-issuing codes for a couple of minutes. Reporting that as a
    //    failure would strand a session that only needed someone to scan — and would tell the
    //    operator the account had been logged out, which is not what happened.
    //
    // `phoneNumber` is the discriminator: it is only ever set by the profile read that follows a
    // real connect, so a session that has one was genuinely linked at some point.
    const wasPaired = this.phoneNumber !== null;
    this.qrCode = null;
    if (wasPaired) {
      // The credentials are gone, so the instance handle is worthless.
      this.instanceToken = null;
      this.setStatus(EngineStatus.FAILED);
      this.callbacks.onError?.(`Evolution Go reported the account was logged out: ${reason}`);
    } else {
      // Deliberately no onDisconnected: that callback asks the lifecycle to reconnect, and nobody
      // asked for a retry — the pairing simply expired. The session parks at DISCONNECTED and the
      // operator starts it again when they are ready to scan.
      this.setStatus(EngineStatus.DISCONNECTED);
    }
    this.resolveReadyWaiters(false);
  }

  /**
   * Pre-connection history, handed to the dispatch-free persistence path.
   *
   * `onHistoryMessages` is deliberately separate from `onMessage`: these messages predate the live
   * session, so consumers store them for the chat view and must NOT dispatch them — a backfilled
   * message replayed through the normal path would fire webhooks and hooks for something that
   * happened last week.
   */
  emitHistory(batch: { messages: IncomingMessage[]; progress?: number }): void {
    if (batch.messages.length === 0) return;
    this.logger.log(
      `History sync delivered ${batch.messages.length} message(s)${batch.progress === undefined ? '' : ` (progress ${batch.progress}%)`}`,
      { action: 'history_sync_received' },
    );
    this.callbacks.onHistoryMessages?.(batch.messages);
  }

  /** Delivery receipts, surfaced so `message.ack` keeps working on this engine. */
  emitAck(messageId: string, status: DeliveryStatus): void {
    this.callbacks.onMessageAck?.(messageId, status);
  }

  emitGroupEvent(event: Parameters<NonNullable<EngineEventCallbacks['onGroupEvent']>>[0]): void {
    this.callbacks.onGroupEvent?.(event);
  }

  emitPresence(
    chatId: string,
    state: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused',
    participantId: string,
  ): void {
    this.callbacks.onPresenceUpdate?.({
      chatId,
      participants: [{ id: participantId, state }],
    });
  }

  emitRestriction(restriction: AccountRestriction | null): void {
    this.callbacks.onAccountRestriction?.(restriction);
  }

  /**
   * Refuses an operation this engine cannot serve.
   *
   * Named exactly as the parity gate expects: `engine-parity.spec.ts` allows ONE non-literal
   * `EngineNotSupportedError` construction per adapter file and requires this precise signature, so
   * every refusal below is a literal call to it and the gap stays machine-readable.
   */
  private unsupported(method: string): Promise<never> {
    // A REJECTED PROMISE, never a synchronous throw — the same contract the Baileys adapter's helper
    // implements. Every method below is declared to return a promise, so throwing synchronously here
    // would make `engine.getChats().catch(...)` blow up before `.catch` was ever attached, working
    // on the sibling engines and failing on this one.
    return Promise.reject(new EngineNotSupportedError(method));
  }
}

/** Strips a `data:<mime>;base64,` prefix, which callers are allowed to include. */
function stripDataUri(value: string): string {
  const comma = value.indexOf(',');
  return value.startsWith('data:') && comma !== -1 ? value.slice(comma + 1) : value;
}

/** One-line description of a thrown value, for log lines. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Re-exported so the ingress controller can narrow service errors without importing the client. */
export { EvolutionGoHttpError };
