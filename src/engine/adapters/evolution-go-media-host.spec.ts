import { createHmac } from 'node:crypto';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import type { StorageService } from '../../common/storage/storage.service';
import {
  EVOLUTION_GO_MEDIA_DEFAULT_MIMETYPE,
  EVOLUTION_GO_MEDIA_KEY_PREFIX,
  EVOLUTION_GO_MEDIA_URL_PATH,
  EvolutionGoMediaHost,
  type EvolutionGoMediaHostOptions,
} from './evolution-go-media-host';

/**
 * The host is the authorization boundary for a @Public route: whatever it accepts, the engine (and
 * anyone who can guess a URL) can fetch. So the cases below are weighted toward what it must REFUSE —
 * tampered, foreign-key, truncated, malformed, expired and prefix-escaping tokens — rather than toward
 * the happy path, which one test already pins end to end.
 *
 * Storage is faked rather than reachable: a real StorageService constructs a ConfigService, an S3
 * client and a local directory, so no test here may touch a filesystem or a bucket. Time is injected
 * for the same reason a fake timer is avoided — a fake timer pins the process clock, and this file
 * needs to observe both sides of an expiry boundary.
 */

/** A Map-backed StorageService, implementing exactly the four methods the host calls. */
class FakeStorage {
  readonly files = new Map<string, Buffer>();
  readonly deletedKeys: string[] = [];
  /** Keys whose delete must fail, for the sweep's per-key error path. */
  readonly failingDeletes = new Set<string>();

  // Returned promises rather than \`async\` + a plain value: these stand in for methods that ARE
  // promise-returning, and a fake that resolves synchronously would let a missing \`await\` in the host
  // pass here and fail against the real StorageService.
  readonly putFile = jest.fn((key: string, data: Buffer): Promise<void> => {
    this.files.set(key, data);
    return Promise.resolve();
  });

  readonly deleteFile = jest.fn((key: string): Promise<void> => {
    if (this.failingDeletes.has(key)) return Promise.reject(new Error('storage backend refused the delete'));
    this.files.delete(key);
    this.deletedKeys.push(key);
    return Promise.resolve();
  });

  // Wrapped so a test can assert the sweep asks for the prefix rather than walking the whole store.
  readonly iterateFiles = jest.fn((prefix: string = ''): AsyncGenerator<string> => this.list(prefix));

  getFile(key: string): Promise<Buffer> {
    const stored = this.files.get(key);
    if (!stored) return Promise.reject(Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' }));
    return Promise.resolve(stored);
  }

  // The real iterateFiles is an async generator, so the fake has to be one too — and there is nothing
  // inside this one to await.
  // eslint-disable-next-line @typescript-eslint/require-await
  private async *list(prefix: string): AsyncGenerator<string> {
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(prefix)) yield key;
    }
  }
}

const SECRET = 'test-media-secret';
const BASE_URL = 'http://openwa-api:2785';
const TTL_SECONDS = 300;
/** Whole-minute epoch; the second boundary is what the expiry tests move across. */
const CLOCK_START_MS = Date.UTC(2025, 0, 1);
const CLOCK_START_SECONDS = Math.floor(CLOCK_START_MS / 1000);

interface Harness {
  host: EvolutionGoMediaHost;
  storage: FakeStorage;
  /** Mutable so a test can move time without touching the process clock. */
  clock: { nowMs: number };
}

function makeHarness(overrides: Partial<EvolutionGoMediaHostOptions> = {}): Harness {
  const storage = new FakeStorage();
  const clock = { nowMs: CLOCK_START_MS };
  const host = new EvolutionGoMediaHost(storage as unknown as StorageService, {
    callbackBaseUrl: BASE_URL,
    secret: SECRET,
    ttlSeconds: TTL_SECONDS,
    now: () => clock.nowMs,
    ...overrides,
  });
  return { host, storage, clock };
}

const BUFFER_OPTIONS = {
  sessionId: 'session-1',
  buffer: Buffer.from('outbound-bytes'),
  mimetype: 'image/png',
  filename: 'photo.png',
};

/** The token is the last path segment of the URL the host returns. */
function tokenOf(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1);
}

/** A token built the way the host builds one, so a case the public API cannot express is still signable. */
function forge(payload: unknown, secret = SECRET): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${createHmac('sha256', secret).update(encodedPayload).digest('base64url')}`;
}

/** A payload the host itself would sign, with one field replaceable. */
function payloadWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    s: 'session-1',
    k: `${EVOLUTION_GO_MEDIA_KEY_PREFIX}${CLOCK_START_SECONDS + TTL_SECONDS}-00000000-0000-4000-8000-000000000000`,
    e: CLOCK_START_SECONDS + TTL_SECONDS,
    m: 'image/png',
    f: 'photo.png',
    ...overrides,
  };
}

/** Seed a blob under the prefix without going through hostBuffer (which would also mint a token). */
function seed(storage: FakeStorage, expiresAt: number, name = '00000000-0000-4000-8000-000000000000'): string {
  const key = `${EVOLUTION_GO_MEDIA_KEY_PREFIX}${expiresAt}-${name}`;
  storage.files.set(key, Buffer.from('seeded'));
  return key;
}

describe('EvolutionGoMediaHost — hosting', () => {
  it('returns a URL on the configured base, under the path the controller serves', async () => {
    const { host } = makeHarness();

    const url = await host.hostBuffer(BUFFER_OPTIONS);

    // The engine fetches from its own container, so the base URL is the deployment's own problem — but
    // the PATH must be the controller's, or every send fails on a 404 nothing logs.
    expect(url.startsWith(`${BASE_URL}${EVOLUTION_GO_MEDIA_URL_PATH}/`)).toBe(true);
    expect(tokenOf(url).length).toBeGreaterThan(0);
  });

  it('trims a trailing slash on the base so the path is not doubled', async () => {
    const { host } = makeHarness({ callbackBaseUrl: `${BASE_URL}/` });

    await expect(host.hostBuffer(BUFFER_OPTIONS)).resolves.toContain(`${BASE_URL}${EVOLUTION_GO_MEDIA_URL_PATH}/`);
  });

  it('persists the bytes under the prefix, with the expiry encoded in the key', async () => {
    const { host, storage } = makeHarness();

    const url = await host.hostBuffer(BUFFER_OPTIONS);
    const descriptor = host.readToken(tokenOf(url));

    expect(descriptor).not.toBeNull();
    // The sweep decides from the key alone, so the key and the signed expiry must agree — a divergence
    // would let a sweep delete a blob whose URL is still valid.
    expect(descriptor?.storageKey.startsWith(EVOLUTION_GO_MEDIA_KEY_PREFIX)).toBe(true);
    expect(Number(descriptor?.storageKey.slice(EVOLUTION_GO_MEDIA_KEY_PREFIX.length).split('-')[0])).toBe(
      descriptor?.expiresAt,
    );
    expect(descriptor?.expiresAt).toBe(CLOCK_START_SECONDS + TTL_SECONDS);
    expect(storage.putFile).toHaveBeenCalledWith(descriptor?.storageKey, BUFFER_OPTIONS.buffer);
    expect(storage.files.get(descriptor?.storageKey ?? '')).toEqual(BUFFER_OPTIONS.buffer);
  });

  it('mints a different token and a different key for the same bytes', async () => {
    const { host } = makeHarness();

    const first = tokenOf(await host.hostBuffer(BUFFER_OPTIONS));
    const second = tokenOf(await host.hostBuffer(BUFFER_OPTIONS));

    // A reused URL would let one send's expiry — and one send's blob — govern the next.
    expect(second).not.toBe(first);
    expect(host.readToken(first)?.storageKey).not.toBe(host.readToken(second)?.storageKey);
    expect(host.readToken(first)).not.toBeNull();
    expect(host.readToken(second)).not.toBeNull();
  });

  const unusable: Array<[string, Partial<EvolutionGoMediaHostOptions>]> = [
    ['no secret', { secret: '' }],
    ['no callback base url', { callbackBaseUrl: '  ' }],
    ['a zero ttl', { ttlSeconds: 0 }],
    ['a NaN ttl', { ttlSeconds: Number.NaN }],
  ];

  it.each(unusable)(
    'refuses to mint with %s, rather than serving a URL nothing can fetch',
    async (label, overrides) => {
      const { host } = makeHarness(overrides);

      expect({ case: label, configured: host.isConfigured() }).toEqual({ case: label, configured: false });
      await expect(host.hostBuffer(BUFFER_OPTIONS)).rejects.toBeInstanceOf(EngineTransportError);
    },
  );
});

describe('EvolutionGoMediaHost — token verification', () => {
  it('accepts a freshly issued token and returns what was hosted', async () => {
    const { host } = makeHarness();

    const descriptor = host.readToken(tokenOf(await host.hostBuffer(BUFFER_OPTIONS)));

    expect(descriptor).toMatchObject({
      sessionId: 'session-1',
      mimetype: 'image/png',
      filename: 'photo.png',
      expiresAt: CLOCK_START_SECONDS + TTL_SECONDS,
    });
  });

  it('rejects a tampered payload', async () => {
    const { host } = makeHarness();
    const token = tokenOf(await host.hostBuffer(BUFFER_OPTIONS));
    const [payload, signature] = token.split('.');
    const flipped = `${payload[0] === 'A' ? 'B' : 'A'}${payload.slice(1)}`;

    expect(host.readToken(`${flipped}.${signature}`)).toBeNull();
  });

  it('rejects a tampered signature', async () => {
    const { host } = makeHarness();
    const token = tokenOf(await host.hostBuffer(BUFFER_OPTIONS));
    const [payload, signature] = token.split('.');
    const flipped = `${signature.slice(0, -1)}${signature.at(-1) === 'A' ? 'B' : 'A'}`;

    expect(host.readToken(`${payload}.${flipped}`)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const issuer = makeHarness();
    const verifier = makeHarness({ secret: 'another-secret' });
    const token = tokenOf(await issuer.host.hostBuffer(BUFFER_OPTIONS));

    expect(verifier.host.readToken(token)).toBeNull();
    // The token itself is sound — only the key differs — so this is the signature being checked, not
    // some other rejection in disguise.
    expect(issuer.host.readToken(token)).not.toBeNull();
  });

  it('rejects an expired token, and keeps accepting it until the expiry second', async () => {
    const { host, clock } = makeHarness();
    const token = tokenOf(await host.hostBuffer(BUFFER_OPTIONS));

    clock.nowMs = (CLOCK_START_SECONDS + TTL_SECONDS - 1) * 1000;
    expect(host.readToken(token)).not.toBeNull();

    // Half-open: the token stops being servable AT its expiry, not one second later.
    clock.nowMs = (CLOCK_START_SECONDS + TTL_SECONDS) * 1000;
    expect(host.readToken(token)).toBeNull();
  });

  const malformed = ['', 'not-a-token', '.', 'abc.', '.abc', 'a.b.c', 'a.b', 'AAAA', '...'];
  it.each(malformed)('rejects the structurally malformed token %p', token => {
    const { host } = makeHarness();

    expect(host.readToken(token)).toBeNull();
  });

  it.each(['full', 'payload-truncated', 'signature-truncated'] as const)('rejects a %s token', async truncation => {
    const { host } = makeHarness();
    const token = tokenOf(await host.hostBuffer(BUFFER_OPTIONS));
    const [payload, signature] = token.split('.');
    const truncated =
      truncation === 'full'
        ? token.slice(0, -4)
        : truncation === 'payload-truncated'
          ? `${payload.slice(0, 10)}.${signature}`
          : `${payload}.${signature.slice(0, 10)}`;

    expect(host.readToken(truncated)).toBeNull();
  });

  it('rejects a correctly signed token naming a key outside the host prefix', () => {
    const { host } = makeHarness();

    // Signed with the REAL secret (so this is not the signature failing): if it were accepted, a leaked
    // secret would become a read of every object in the store, not just hosted media.
    const token = forge(payloadWith({ k: 'sessions/other-object.json' }));

    expect(host.readToken(token)).toBeNull();
  });

  it('rejects a correctly signed token of an unknown version', () => {
    const { host } = makeHarness();

    expect(host.readToken(forge(payloadWith({ v: 2 })))).toBeNull();
    expect(host.readToken(forge(payloadWith({ v: '1' })))).toBeNull();
  });

  const invalidPayloads: Array<[string, Record<string, unknown>]> = [
    ['no session id', { s: '' }],
    ['a non-string session id', { s: 7 }],
    ['a non-string key', { k: 7 }],
    ['a non-numeric expiry', { e: 'soon' }],
    ['a fractional expiry', { e: 1.5 }],
    ['a missing mimetype', { m: '' }],
    ['a non-string mimetype', { m: null }],
    ['a non-string filename', { f: 7 }],
  ];

  it.each(invalidPayloads)('rejects a correctly signed payload with %s', (_label, overrides) => {
    const { host } = makeHarness();

    expect(host.readToken(forge(payloadWith(overrides)))).toBeNull();
  });

  it('rejects a signed payload that is not JSON at all', () => {
    const { host } = makeHarness();
    const encodedPayload = Buffer.from('not json at all', 'utf8').toString('base64url');
    const token = `${encodedPayload}.${createHmac('sha256', SECRET).update(encodedPayload).digest('base64url')}`;

    expect(host.readToken(token)).toBeNull();
  });

  it('treats an empty secret as "verify nothing", never as "verify anything"', async () => {
    const issuer = makeHarness();
    const unconfigured = makeHarness({ secret: '' });
    const token = tokenOf(await issuer.host.hostBuffer(BUFFER_OPTIONS));

    // An empty HMAC key makes every signature reproducible by anyone, so the unconfigured host must
    // refuse — the same fail-closed stance the ingress takes on an empty shared secret.
    expect(unconfigured.host.readToken(token)).toBeNull();
  });
});

describe('EvolutionGoMediaHost — sweeping', () => {
  it('deletes the blobs whose expiry has passed and leaves the rest', async () => {
    const { host, storage } = makeHarness();
    const expired = seed(storage, CLOCK_START_SECONDS - 1);
    const exactlyNow = seed(storage, CLOCK_START_SECONDS);
    const future = seed(storage, CLOCK_START_SECONDS + 1);

    await expect(host.sweepExpired()).resolves.toBe(2);

    expect(storage.deletedKeys.sort()).toEqual([expired, exactlyNow].sort());
    expect([...storage.files.keys()]).toEqual([future]);
    // The prefix narrows the walk at the source: a sweep that listed the whole store would page every
    // unrelated object and hold their keys while deciding about media.
    expect(storage.iterateFiles).toHaveBeenCalledWith(EVOLUTION_GO_MEDIA_KEY_PREFIX);
  });

  it('leaves keys it did not write alone, and reports them', async () => {
    const { host, storage } = makeHarness();
    const noSeparator = `${EVOLUTION_GO_MEDIA_KEY_PREFIX}not-a-key`;
    const zeroEpoch = `${EVOLUTION_GO_MEDIA_KEY_PREFIX}0-0000`;
    const absurdEpoch = `${EVOLUTION_GO_MEDIA_KEY_PREFIX}99999999999999999999-0000`;
    const unrelated = 'sessions/chats.json';
    for (const key of [noSeparator, zeroEpoch, absurdEpoch, unrelated]) storage.files.set(key, Buffer.from('x'));

    await expect(host.sweepExpired()).resolves.toBe(0);

    // Mid-rollout an older sweeper must not delete what a newer format just wrote, and a key with no
    // readable expiry is not evidence that one has passed — so it stays, visibly, rather than silently.
    expect([...storage.files.keys()].sort()).toEqual([absurdEpoch, noSeparator, unrelated, zeroEpoch].sort());
  });

  it('keeps sweeping after one delete fails', async () => {
    const { host, storage } = makeHarness();
    const refused = seed(storage, CLOCK_START_SECONDS - 10);
    const removed = seed(storage, CLOCK_START_SECONDS - 20);
    storage.failingDeletes.add(refused);

    await expect(host.sweepExpired()).resolves.toBe(1);

    expect(storage.deletedKeys).toEqual([removed]);
    expect([...storage.files.keys()]).toEqual([refused]);
  });

  it('is a no-op on an empty store', async () => {
    const { host } = makeHarness();

    await expect(host.sweepExpired()).resolves.toBe(0);
  });
});

describe('EvolutionGoMediaHost — mimetype normalisation', () => {
  it('keeps a well-formed mimetype, parameters and all', async () => {
    const { host } = makeHarness();

    const descriptor = host.readToken(
      tokenOf(await host.hostBuffer({ ...BUFFER_OPTIONS, mimetype: 'audio/ogg; codecs=opus' })),
    );

    expect(descriptor?.mimetype).toBe('audio/ogg; codecs=opus');
  });

  const unusableMimetypes = [
    'image/png\r\nX-Injected: 1',
    'image/png"',
    'not-a-mimetype',
    '',
    'image/',
    'image/png extra',
  ];

  it.each(unusableMimetypes)('replaces the unusable mimetype %p before signing it', async mimetype => {
    const { host } = makeHarness();

    const descriptor = host.readToken(tokenOf(await host.hostBuffer({ ...BUFFER_OPTIONS, mimetype })));

    // It leaves again as a response header, so an unusable value is replaced at ISSUE time — the token
    // can then only ever carry something already safe to serve.
    expect(descriptor?.mimetype).toBe(EVOLUTION_GO_MEDIA_DEFAULT_MIMETYPE);
  });
});
