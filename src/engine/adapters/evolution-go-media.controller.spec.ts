import { validateHeaderValue } from 'node:http';
import { NotFoundException, RequestMethod, StreamableFile } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, RESPONSE_PASSTHROUGH_METADATA } from '@nestjs/common/constants';
import type { Response } from 'express';
import type { StorageService } from '../../common/storage/storage.service';
import { PUBLIC_KEY } from '../../modules/auth/decorators/auth.decorators';
import {
  EVOLUTION_GO_MEDIA_DEFAULT_MIMETYPE,
  EVOLUTION_GO_MEDIA_ROUTE,
  EVOLUTION_GO_MEDIA_URL_PATH,
  EvolutionGoMediaHost,
} from './evolution-go-media-host';
import { EvolutionGoMediaController } from './evolution-go-media.controller';

/**
 * This route is the one place in the engine layer that answers an unauthenticated caller with bytes, so
 * what it is worth asserting is the shape of the fence and the shape of the refusals — not that a Buffer
 * travels, which the host spec already pins.
 *
 * The fake storage is deliberately NOT shared with evolution-go-media-host.spec.ts: importing it would
 * register that file's describes a second time, in this file. Time is injected rather than faked so the
 * expiry case can cross a real second boundary without freezing the process clock.
 */

/** A Map-backed StorageService holding whatever a test seeds into it. */
class FakeStorage {
  readonly files = new Map<string, Buffer>();
  /** Set to make the next read fail the way a backend outage does — a non-missing-object error. */
  readFailure: Error | null = null;

  // Returned promises rather than \`async\` + a plain value, so a missing \`await\` in the controller
  // cannot pass here while failing against the real, promise-returning StorageService.
  getFile(key: string): Promise<Buffer> {
    if (this.readFailure) return Promise.reject(this.readFailure);
    const stored = this.files.get(key);
    if (!stored) return Promise.reject(Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' }));
    return Promise.resolve(stored);
  }

  putFile = jest.fn((key: string, data: Buffer): Promise<void> => {
    this.files.set(key, data);
    return Promise.resolve();
  });

  // An async generator because the real StorageService.iterateFiles is one; nothing inside it awaits.
  // eslint-disable-next-line @typescript-eslint/require-await
  async *iterateFiles(): AsyncGenerator<string> {
    for (const key of this.files.keys()) yield key;
  }
}

const SECRET = 'test-media-secret';
const BASE_URL = 'http://openwa-api:2785';
const TTL_SECONDS = 300;
const CLOCK_START_MS = Date.UTC(2025, 0, 1);

const BUFFER_OPTIONS = {
  sessionId: 'session-1',
  buffer: Buffer.from('outbound-bytes'),
  mimetype: 'image/png',
  filename: 'photo.png',
};

interface Harness {
  controller: EvolutionGoMediaController;
  host: EvolutionGoMediaHost;
  storage: FakeStorage;
  clock: { nowMs: number };
}

function makeHarness(options: { secret?: string; now?: () => number } = {}): Harness {
  const storage = new FakeStorage();
  const clock = { nowMs: CLOCK_START_MS };
  const host = new EvolutionGoMediaHost(storage as unknown as StorageService, {
    callbackBaseUrl: BASE_URL,
    secret: options.secret ?? SECRET,
    ttlSeconds: TTL_SECONDS,
    now: options.now ?? (() => clock.nowMs),
  });
  return {
    controller: new EvolutionGoMediaController(host, storage as unknown as StorageService),
    host,
    storage,
    clock,
  };
}

const tokenOf = (url: string): string => url.slice(url.lastIndexOf('/') + 1);

/** Express merges the object form of `res.set` into the header bag; accumulating mirrors that. */
async function serve(
  harness: Harness,
  token: string,
): Promise<{ file: StreamableFile; headers: Record<string, string> }> {
  const headers: Record<string, string> = {};
  const res = { set: (fields: Record<string, string>) => Object.assign(headers, fields) } as unknown as Response;

  const file = await harness.controller.fetch(token, res);

  return { file, headers };
}

/**
 * The 404 a token produces, returned so two different causes can be compared. Asserts on the way through
 * that a refusal carries NO headers: a 404 with a Content-Type and a Content-Disposition is a response
 * that already decided to serve something.
 */
async function refusal(harness: Harness, token: string): Promise<NotFoundException> {
  const set = jest.fn();
  const res = { set } as unknown as Response;
  try {
    await harness.controller.fetch(token, res);
  } catch (error) {
    expect(set).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(NotFoundException);
    return error as NotFoundException;
  }
  throw new Error('the controller served a token it was supposed to refuse');
}

describe('EvolutionGoMediaController — routing', () => {
  it('is mounted under the global prefix once, not twice', () => {
    // app-validation.ts sets the 'api' global prefix; repeating it in @Controller would publish
    // /api/api/... while the host hands the engine a single-prefixed URL, and every fetch would 404.
    expect(Reflect.getMetadata(PATH_METADATA, EvolutionGoMediaController)).toBe('engine/evolution-go/media');
    expect(EVOLUTION_GO_MEDIA_URL_PATH).toBe(`/api/${EVOLUTION_GO_MEDIA_ROUTE}`);
  });

  it('is @Public, which is the only reason the engine service can fetch it at all', () => {
    // The caller is the engine container: it has no API key and cannot be given one, so the signed
    // token in the path is the authorization. Without this the global ApiKeyGuard 401s every fetch.
    expect(Reflect.getMetadata(PUBLIC_KEY, EvolutionGoMediaController)).toBe(true);
  });

  it('exposes exactly one route, and it is a GET — there is no cleanup route', () => {
    const handlers = Object.getOwnPropertyNames(EvolutionGoMediaController.prototype).filter(
      name => name !== 'constructor',
    );
    const methods = handlers
      .map(
        name =>
          Reflect.getMetadata(
            METHOD_METADATA,
            (EvolutionGoMediaController.prototype as unknown as Record<string, object>)[name],
          ) as RequestMethod | undefined,
      )
      .filter((method): method is RequestMethod => method !== undefined);

    // An unauthenticated DELETE in front of the store is a worse thing to own than a stale blob;
    // eviction is the sweep, which only this application can reach.
    expect(methods).toEqual([RequestMethod.GET]);
  });

  it('declares the response passthrough, or Nest discards the file the handler returns', () => {
    // The headers go through res.set, so without passthrough Nest would end the response before the
    // StreamableFile is written.
    expect(Reflect.getMetadata(RESPONSE_PASSTHROUGH_METADATA, EvolutionGoMediaController, 'fetch')).toBe(true);
  });
});

describe('EvolutionGoMediaController — serving', () => {
  it('returns the stored bytes with the hosted mimetype, filename and nosniff', async () => {
    const harness = makeHarness();
    const token = tokenOf(await harness.host.hostBuffer(BUFFER_OPTIONS));

    const { file, headers } = await serve(harness, token);

    expect(file.getStream().read()).toEqual(BUFFER_OPTIONS.buffer);
    expect(headers['Content-Type']).toBe('image/png');
    expect(headers['Content-Disposition']).toBe('inline; filename="photo.png"');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });

  const hostileNames = [
    'a quote',
    'a CR/LF injection',
    'a backslash',
    'a path separator',
    'a NUL byte',
    'a leading quote and a trailing one',
  ];
  const hostileFilename = (label: string): string => {
    switch (label) {
      case 'a quote':
        return 'ev"il.png';
      case 'a CR/LF injection':
        return 'evil.png\r\nX-Injected: 1';
      case 'a backslash':
        return 'ev\\il.png';
      case 'a path separator':
        return '../../etc/passwd';
      case 'a NUL byte':
        return 'ev\u0000il.png';
      default:
        return '"evil.png"';
    }
  };

  it.each(hostileNames)('neutralises %s in the Content-Disposition', async label => {
    const filename = hostileFilename(label);
    const harness = makeHarness();
    const token = tokenOf(await harness.host.hostBuffer({ ...BUFFER_OPTIONS, filename }));

    const { headers } = await serve(harness, token);
    const disposition = headers['Content-Disposition'];
    const quoted = /^inline; filename="(.*)"$/.exec(disposition);

    // The value is still exactly one quoted parameter — a stray quote would end it early and let the
    // rest of the caller's string become header syntax.
    expect(quoted).not.toBeNull();
    expect(quoted?.[1]).not.toMatch(/["\\\r\n]/);
    // Named here rather than asserted as a literal per case, so the table can grow without the
    // expectation becoming a copy of the implementation.
    expect(quoted?.[1].length).toBeGreaterThan(0);
    // node:http's own validator, the one res.set runs before it writes anything: this is the check a
    // real response would do, not a mock's opinion of it.
    expect(() => validateHeaderValue('Content-Disposition', disposition)).not.toThrow();
  });

  it('keeps a filename written outside latin1 header range out of the header', async () => {
    const harness = makeHarness();
    const token = tokenOf(await harness.host.hostBuffer({ ...BUFFER_OPTIONS, filename: '日本語の写真.png' }));

    const { headers } = await serve(harness, token);

    // Node's res.set throws ERR_INVALID_CHAR on a non-latin1 header value, which would turn a perfectly
    // valid URL into a 500 for a file named in Japanese.
    expect(() => validateHeaderValue('Content-Disposition', headers['Content-Disposition'])).not.toThrow();
    expect(headers['Content-Disposition']).toMatch(/^inline; filename="[\x20-\x7e]+"$/);
  });

  it('substitutes a name when sanitising leaves nothing at all', async () => {
    const harness = makeHarness();
    const token = tokenOf(await harness.host.hostBuffer({ ...BUFFER_OPTIONS, filename: '"\u0000\\"' }));

    const { headers } = await serve(harness, token);

    expect(headers['Content-Disposition']).toBe('inline; filename="media"');
  });

  it('bounds a pathologically long filename', async () => {
    const harness = makeHarness();
    const token = tokenOf(await harness.host.hostBuffer({ ...BUFFER_OPTIONS, filename: `${'a'.repeat(500)}.png` }));

    const { headers } = await serve(harness, token);
    const quoted = /^inline; filename="(.*)"$/.exec(headers['Content-Disposition']);

    expect(quoted?.[1].length).toBeLessThanOrEqual(200);
    expect(() => validateHeaderValue('Content-Disposition', headers['Content-Disposition'])).not.toThrow();
  });

  it('serves the mimetype the token recorded, not one the caller can inject into the header', async () => {
    const harness = makeHarness();
    const token = tokenOf(
      await harness.host.hostBuffer({ ...BUFFER_OPTIONS, mimetype: 'text/plain\r\nX-Injected: 1' }),
    );

    const { headers } = await serve(harness, token);

    expect(headers['Content-Type']).toBe(EVOLUTION_GO_MEDIA_DEFAULT_MIMETYPE);
    expect(() => validateHeaderValue('Content-Type', headers['Content-Type'])).not.toThrow();
  });
});

describe('EvolutionGoMediaController — refusals', () => {
  it('answers 404 — never 401 or 403 — for a token it cannot verify', async () => {
    const harness = makeHarness();

    const refused = await refusal(harness, 'not-a-token');

    // The caller presents no credential here, so an auth-shaped status would suggest one exists to be
    // presented, and would send the engine's operator looking for a key to configure.
    expect(refused.getStatus()).toBe(404);
  });

  const rejectedTokens = ['', 'not-a-token', 'a.b.c', '.', 'AAAA', 'x'.repeat(200)];

  it.each(rejectedTokens)('refuses the malformed token %p', async token => {
    const harness = makeHarness();

    await expect(refusal(harness, token)).resolves.toBeInstanceOf(NotFoundException);
  });

  it('refuses a truncated token', async () => {
    const harness = makeHarness();
    const token = tokenOf(await harness.host.hostBuffer(BUFFER_OPTIONS));

    await expect(refusal(harness, token.slice(0, token.length - 6))).resolves.toBeInstanceOf(NotFoundException);
    await expect(refusal(harness, token.slice(0, 12))).resolves.toBeInstanceOf(NotFoundException);
  });

  it('refuses a tampered token', async () => {
    const harness = makeHarness();
    const token = tokenOf(await harness.host.hostBuffer(BUFFER_OPTIONS));
    const [payload, signature] = token.split('.');

    await expect(
      refusal(harness, `${payload[0] === 'A' ? 'B' : 'A'}${payload.slice(1)}.${signature}`),
    ).resolves.toBeInstanceOf(NotFoundException);
    // Tamper a character in the MIDDLE of the signature, never the last one. In base64url the final
    // character carries padding bits, so several distinct characters decode to the SAME bytes — a
    // last-character swap is therefore not reliably a tamper, and the test passed or failed on which
    // byte the encoder happened to emit.
    const midpoint = Math.floor(signature.length / 2);
    await expect(
      refusal(
        harness,
        `${payload}.${signature.slice(0, midpoint)}${signature[midpoint] === 'A' ? 'B' : 'A'}${signature.slice(midpoint + 1)}`,
      ),
    ).resolves.toBeInstanceOf(NotFoundException);
  });

  it('refuses a token signed with a different secret', async () => {
    const issuer = makeHarness();
    const verifier = makeHarness({ secret: 'another-secret' });
    const token = tokenOf(await issuer.host.hostBuffer(BUFFER_OPTIONS));

    await expect(refusal(verifier, token)).resolves.toBeInstanceOf(NotFoundException);
  });

  it('refuses an expired token', async () => {
    const harness = makeHarness();
    const token = tokenOf(await harness.host.hostBuffer(BUFFER_OPTIONS));

    harness.clock.nowMs = (Math.floor(CLOCK_START_MS / 1000) + TTL_SECONDS + 1) * 1000;

    await expect(refusal(harness, token)).resolves.toBeInstanceOf(NotFoundException);
  });

  it('refuses a token whose blob is no longer there', async () => {
    const harness = makeHarness();
    const token = tokenOf(await harness.host.hostBuffer(BUFFER_OPTIONS));
    harness.storage.files.clear();

    await expect(refusal(harness, token)).resolves.toBeInstanceOf(NotFoundException);
  });

  it('reports a storage outage as a failure, not as a missing blob', async () => {
    const harness = makeHarness();
    const token = tokenOf(await harness.host.hostBuffer(BUFFER_OPTIONS));
    harness.storage.readFailure = new Error('storage backend exploded');

    // Folding an outage into a 404 would send the engine's operator hunting for a bad link that is fine.
    const res = { set: jest.fn() } as unknown as Response;
    await expect(harness.controller.fetch(token, res)).rejects.toThrow('storage backend exploded');
    await expect(harness.controller.fetch(token, res)).rejects.not.toBeInstanceOf(NotFoundException);
  });

  it('gives the same answer to every cause, so a probe learns which part passed', async () => {
    const harness = makeHarness();
    const token = tokenOf(await harness.host.hostBuffer(BUFFER_OPTIONS));
    const [payload, signature] = token.split('.');

    const malformed = await refusal(harness, 'not-a-token');
    const tampered = await refusal(harness, `${payload}.${signature.slice(0, -1)}A`);
    harness.clock.nowMs = (Math.floor(CLOCK_START_MS / 1000) + TTL_SECONDS + 1) * 1000;
    const expired = await refusal(harness, token);

    expect(tampered.message).toBe(malformed.message);
    expect(expired.message).toBe(malformed.message);
  });
});
