/**
 * Behaviour tests for the evolution-go adapter.
 *
 * These cover the decisions that are easy to get wrong and expensive to get wrong, rather than the
 * 112-method surface (which the capability-matrix parity gate already walks structurally):
 *
 *  - the HTTP-200-with-no-message-id case, where the service accepted the call and WhatsApp refused
 *    the message — reporting that as success is how a message reads SENT that never left;
 *  - the neutral↔service JID translation;
 *  - media, which the service fetches by URL and therefore cannot receive as bytes;
 *  - that every method the matrix calls unavailable really throws, so a caller never gets an empty
 *    answer where it should get a 501.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'undici';
import { EvolutionGoAdapter, type EvolutionGoEngineConfig, type MediaHost } from './evolution-go.adapter';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';

jest.mock('undici', () => ({ request: jest.fn() }));

const mockedRequest = request as unknown as jest.Mock;

/** One recorded call to the mocked transport. */
interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
  apikey: string | undefined;
}

let calls: Call[] = [];

/** Answers by path, so a test states only the endpoints it cares about. */
type Handler = (call: Call) => { status: number; body?: unknown } | undefined;

function respond(handler: Handler): void {
  mockedRequest.mockImplementation(
    (url: string, options: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const call: Call = {
        url,
        method: options.method ?? 'GET',
        body: options.body ? (JSON.parse(options.body) as Record<string, unknown>) : undefined,
        apikey: options.headers?.apikey,
      };
      calls.push(call);
      const result = handler(call) ?? { status: 200, body: { data: {}, message: 'success' } };
      return Promise.resolve({
        statusCode: result.status,
        body: { text: () => Promise.resolve(result.body === undefined ? '' : JSON.stringify(result.body)) },
      });
    },
  );
}

function pathOf(call: Call): string {
  return new URL(call.url).pathname;
}

function config(overrides: Partial<EvolutionGoEngineConfig> = {}): EvolutionGoEngineConfig {
  return {
    baseUrl: 'http://engine.test:8080',
    apiKey: 'global-key',
    callbackBaseUrl: 'http://openwa.test:2785',
    ingressSecret: 'shh',
    instancePrefix: 'openwa-',
    stateDir: '/tmp/unused',
    timeoutMs: 5000,
    mediaTimeoutMs: 60000,
    mediaTtlSeconds: 300,
    subscribe: ['MESSAGE'],
    ...overrides,
  };
}

let stateDir: string;

beforeEach(() => {
  calls = [];
  stateDir = mkdtempSync(join(tmpdir(), 'evo-state-'));
  mockedRequest.mockReset();
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

/** An adapter with the instance already resolved and connected. */
async function startedAdapter(
  options: { mediaHost?: MediaHost; config?: EvolutionGoEngineConfig } = {},
): Promise<EvolutionGoAdapter> {
  respond(call => {
    if (pathOf(call) === '/instance/all') return { status: 200, body: { data: [], message: 'success' } };
    if (pathOf(call) === '/instance/create')
      return { status: 200, body: { data: { id: 'inst-1', token: 'instance-token' } } };
    return { status: 200, body: { data: {}, message: 'success' } };
  });
  const adapter = new EvolutionGoAdapter({
    sessionId: 'sess-1',
    dbSessionId: 'db-1',
    config: options.config ?? config({ stateDir }),
    mediaHost: options.mediaHost,
  });
  await adapter.initialize({});
  calls = [];
  return adapter;
}

describe('EvolutionGoAdapter — session lifecycle', () => {
  it('creates the instance and registers a per-instance webhook pointing at this gateway', async () => {
    const adapter = new EvolutionGoAdapter({
      sessionId: 'sess-1',
      dbSessionId: 'db-1',
      config: config({ stateDir }),
    });
    respond(call => {
      if (pathOf(call) === '/instance/all') return { status: 200, body: { data: [] } };
      if (pathOf(call) === '/instance/create') return { status: 200, body: { data: { id: 'inst-1', token: 'tok' } } };
      return undefined;
    });

    await adapter.initialize({});

    const create = calls.find(c => pathOf(c) === '/instance/create');
    expect(create?.body).toMatchObject({ name: 'openwa-sess-1' });
    // The global key manages instances; the instance token is what the service issues back.
    expect(create?.apikey).toBe('global-key');

    const connect = calls.find(c => pathOf(c) === '/instance/connect');
    // A localhost callback would resolve to the engine's own container, so the URL must be the
    // configured callback base, and the secret rides in the path because the webhook is unsigned.
    expect(connect?.body?.webhookUrl).toBe('http://openwa.test:2785/api/engine/evolution-go/webhook/shh');
    expect(connect?.apikey).toBe('tok');
  });

  it('reuses an existing remote instance when its persisted state is still valid', async () => {
    const shared = config({ stateDir });
    respond(call => {
      if (pathOf(call) === '/instance/all')
        return { status: 200, body: { data: [{ id: 'inst-1', name: 'openwa-sess-1' }] } };
      if (pathOf(call) === '/instance/create') return { status: 200, body: { data: { id: 'inst-1', token: 'tok' } } };
      return undefined;
    });
    const first = new EvolutionGoAdapter({ sessionId: 'sess-1', dbSessionId: 'db-1', config: shared });
    await first.initialize({});
    expect(calls.some(c => pathOf(c) === '/instance/create')).toBe(true);

    // A restart in the same state dir must NOT create a second instance: that would require a fresh
    // QR scan for a session that is still perfectly linked.
    calls = [];
    const second = new EvolutionGoAdapter({ sessionId: 'sess-1', dbSessionId: 'db-1', config: shared });
    await second.initialize({});
    expect(calls.some(c => pathOf(c) === '/instance/create')).toBe(false);
    expect(calls.some(c => pathOf(c) === '/instance/connect')).toBe(true);
  });

  it('refuses to use a session-scoped call before the session is started', async () => {
    const adapter = new EvolutionGoAdapter({ sessionId: 'sess-1', dbSessionId: 'db-1', config: config({ stateDir }) });
    await expect(adapter.getGroups()).rejects.toBeInstanceOf(EngineNotReadyError);
  });

  it('fails initialization when the engine is not configured, and reports FAILED', async () => {
    const adapter = new EvolutionGoAdapter({
      sessionId: 'sess-1',
      dbSessionId: 'db-1',
      config: config({ stateDir, apiKey: '' }),
    });
    const onError = jest.fn();
    await expect(adapter.initialize({ onError })).rejects.toThrow(/EVOLUTION_GO_API_KEY/);
    expect(onError).toHaveBeenCalled();
    expect(adapter.getStatus()).toBe(EngineStatus.FAILED);
  });
});

describe('EvolutionGoAdapter — sending', () => {
  it('translates the neutral @c.us dialect to the service dialect and reads the message id', async () => {
    const adapter = await startedAdapter();
    respond(() => ({ status: 200, body: { data: { Info: { ID: 'MSG1', Timestamp: '1700000000' } } } }));

    const result = await adapter.sendTextMessage('5511999999999@c.us', 'hello');

    expect(result).toEqual({ id: 'MSG1', timestamp: 1700000000 });
    const sent = calls.find(c => pathOf(c) === '/send/text');
    expect(sent?.body).toMatchObject({ number: '5511999999999@s.whatsapp.net', text: 'hello', formatJid: true });
  });

  it('treats HTTP 200 with no message id as a refusal, not a success', async () => {
    const adapter = await startedAdapter();
    // Documented behaviour of the service: it answers 200 and an empty id when WhatsApp rejected the
    // message, so a status-code-only check would report a message SENT that never left.
    respond(() => ({ status: 200, body: { data: { Info: {} } } }));

    await expect(adapter.sendTextMessage('5511999999999@c.us', 'hello')).rejects.toBeInstanceOf(EngineRefusedError);
  });

  it('carries the quoted message id through a reply', async () => {
    const adapter = await startedAdapter();
    respond(() => ({ status: 200, body: { data: { Info: { ID: 'MSG2' } } } }));

    await adapter.replyToMessage('5511999999999@c.us', 'QUOTED1', 'answer');

    const sent = calls.find(c => pathOf(c) === '/send/text');
    expect(sent?.body?.quoted).toEqual({ messageId: 'QUOTED1' });
  });

  it('hosts base64 media and sends the engine a URL it can fetch', async () => {
    const hostBuffer = jest.fn().mockResolvedValue('http://openwa.test:2785/api/engine/evolution-go/media/tok');
    const adapter = await startedAdapter({ mediaHost: { hostBuffer } });
    respond(() => ({ status: 200, body: { data: { Info: { ID: 'IMG1' } } } }));

    await adapter.sendImageMessage('5511999999999@c.us', {
      mimetype: 'image/png',
      data: Buffer.from('bytes'),
      caption: 'hi',
    });

    expect(hostBuffer).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1', mimetype: 'image/png' }));
    const sent = calls.find(c => pathOf(c) === '/send/media');
    // The service has no base64 field at all, so anything but a URL cannot work.
    expect(sent?.body).toMatchObject({
      type: 'image',
      url: 'http://openwa.test:2785/api/engine/evolution-go/media/tok',
      caption: 'hi',
    });
  });

  it('passes a caller-supplied URL straight through without re-hosting it', async () => {
    const hostBuffer = jest.fn();
    const adapter = await startedAdapter({ mediaHost: { hostBuffer } });
    respond(() => ({ status: 200, body: { data: { Info: { ID: 'IMG2' } } } }));

    await adapter.sendImageMessage('5511999999999@c.us', {
      mimetype: 'image/png',
      data: 'https://cdn.example.com/a.png',
    });

    expect(hostBuffer).not.toHaveBeenCalled();
    expect(calls.find(c => pathOf(c) === '/send/media')?.body?.url).toBe('https://cdn.example.com/a.png');
  });

  it('refuses base64 media with a clear error when no media host is wired', async () => {
    const adapter = await startedAdapter();
    await expect(
      adapter.sendImageMessage('5511999999999@c.us', { mimetype: 'image/png', data: Buffer.from('x') }),
    ).rejects.toThrow(/media host/i);
  });
});

describe('EvolutionGoAdapter — capability refusals', () => {
  it('throws 501-shaped errors for every method the capability matrix calls unavailable', async () => {
    const adapter = await startedAdapter();
    const unavailable: Array<[string, () => Promise<unknown>]> = [
      ['getChats', () => adapter.getChats()],
      ['getChatHistory', () => adapter.getChatHistory('x@c.us')],
      ['getCatalog', () => adapter.getCatalog()],
      ['sendCatalog', () => adapter.sendCatalog('x@c.us')],
      ['forwardMessage', () => adapter.forwardMessage('a@c.us', 'b@c.us', 'M1')],
      ['starMessage', () => adapter.starMessage('x@c.us', 'M1', true)],
      ['getContactStatuses', () => adapter.getContactStatuses()],
      ['getGroupMembershipRequests', () => adapter.getGroupMembershipRequests('g@g.us')],
      ['subscribeToPresence', () => adapter.subscribeToPresence('x@c.us')],
      ['postVoiceStatus', () => adapter.postVoiceStatus({ mimetype: 'audio/ogg', data: 'x' }, {})],
    ];
    for (const [name, call] of unavailable) {
      await expect(call()).rejects.toBeInstanceOf(EngineNotSupportedError);
      await expect(call()).rejects.toThrow(name);
    }
  });

  it('never touches the transport for a refused method', async () => {
    const adapter = await startedAdapter();
    await expect(adapter.getChats()).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('identifies the instance it owns, so the ingress can route events to it', async () => {
    const adapter = await startedAdapter();
    expect(adapter.matchesInstance('openwa-sess-1')).toBe(true);
    expect(adapter.matchesInstance('openwa-sess-2')).toBe(false);
  });
});
