/**
 * Hosts outbound media at a URL the Evolution Go service can fetch.
 *
 * The service accepts media ONLY as a URL — `POST /send/media` takes
 * `{number, type, url, caption, filename, delay}` and `POST /send/sticker` takes
 * `{number, sticker, delay}`, with no base64 field anywhere in its contract — while this gateway's
 * own REST API accepts media as EITHER base64 or a URL. A caller who hands us base64 therefore needs
 * those bytes to exist somewhere the service can GET before the send call can be made. This class mints
 * that URL; its controller serves it.
 *
 * Three decisions here have a cheaper version that fails later, so they are stated rather than implied:
 *
 *  - **Durable storage, not memory.** Blobs go through the existing StorageService under
 *    `evolution-go-outbound/`, so the bytes live wherever this deployment already keeps media (the
 *    local dir or the S3/MinIO bucket) and survive a restart between minting the URL and the service
 *    fetching it. An in-process Map would make the URL valid only on the replica that minted it, and
 *    the fetch arrives on whichever replica the load balancer picks — a 404 there is an unexplained
 *    refused send, not a cache miss.
 *  - **A signed, expiring token, not just an unguessable path.** The engine service has no API key, so
 *    the token IS the authorization and the route that serves it is @Public. A random id would be a
 *    capability too, but it could never expire and nothing could measure it; the expiry is signed into
 *    the token instead, and the token carries the whole descriptor so serving needs no lookup for
 *    anything except the bytes themselves.
 *  - **Expiry encoded in the storage KEY.** StorageService carries no metadata beside a blob —
 *    `putFile(key, data)` is the entire write API — so a sweep could only recover an expiry from
 *    metadata that does not exist, and a side index would be a second thing to keep consistent with the
 *    store. Writing it into the key (`evolution-go-outbound/<expiryEpoch>-<uuid>`) lets
 *    {@link EvolutionGoMediaHost.sweepExpired} decide from the listing alone: no read per blob, and the
 *    key remains the only record.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { StorageService } from '../../common/storage/storage.service';
import { createLogger, LoggerService } from '../../common/services/logger.service';

/** Every blob this file owns lives under this prefix, and the sweep walks nothing else. */
export const EVOLUTION_GO_MEDIA_KEY_PREFIX = 'evolution-go-outbound/';

/** The route the fetch lands on, WITHOUT the global 'api' prefix (app-validation.ts) — the controller path. */
export const EVOLUTION_GO_MEDIA_ROUTE = 'engine/evolution-go/media';

/** The same route as the engine sees it: the URL handed out carries the global prefix. */
export const EVOLUTION_GO_MEDIA_URL_PATH = `/api/${EVOLUTION_GO_MEDIA_ROUTE}`;

/**
 * Token format version. A token carrying any other version is refused rather than best-effort parsed,
 * so a future change to the payload can never be read as if it were today's.
 */
const TOKEN_VERSION = 1;

/** Separates the encoded payload from its signature. Not in the base64url alphabet, so the split is unambiguous. */
const TOKEN_SEPARATOR = '.';

/** The digest both sides of the token use, named so the HMAC call and its documentation cannot drift. */
const TOKEN_ALGORITHM = 'sha256';

/** Served when a caller's mimetype is unusable — see {@link normalizeMimetype}. */
export const EVOLUTION_GO_MEDIA_DEFAULT_MIMETYPE = 'application/octet-stream';

/** `type/subtype` with optional `; param=value` pairs; printable ASCII only, by construction. */
const MIMETYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;\s*[a-z0-9-]+=[a-z0-9-]+)*$/i;

export interface EvolutionGoMediaHostOptions {
  /**
   * How the ENGINE service reaches this gateway (`engine.evolutionGo.callbackBaseUrl`). A loopback is
   * wrong: the service fetches from inside its own container, where `localhost` is itself.
   */
  callbackBaseUrl: string;
  /**
   * HMAC key for the token. An EMPTY secret disables issuance entirely rather than signing with an
   * empty key — see {@link EvolutionGoMediaHost.isConfigured}.
   */
  secret: string;
  /** How long a hosted blob stays fetchable. Only has to outlive the send call that fetches it. */
  ttlSeconds: number;
  /**
   * Clock, in ms since the epoch. Injected so expiry and sweeping are testable without fake timers:
   * a fake timer pins the process clock for every test in a file, so the same file can no longer
   * observe anything about how real time is read.
   */
  now?: () => number;
}

export interface EvolutionGoHostBufferOptions {
  /** OpenWA session the blob belongs to. Carried in the token so a fetched blob can be attributed. */
  sessionId: string;
  buffer: Buffer;
  mimetype: string;
  /** Display name: carried verbatim for the send body, sanitised for the header by the controller. */
  filename: string;
}

/** What a verified token says — everything the controller needs except the bytes themselves. */
export interface EvolutionGoMediaDescriptor {
  sessionId: string;
  storageKey: string;
  /** Unix seconds. The token stops being servable at this instant. */
  expiresAt: number;
  mimetype: string;
  filename: string;
}

/** The signed payload as it travels. Short keys keep the token — one URL path segment — small. */
interface EvolutionGoMediaTokenPayload {
  v: number;
  s: string;
  k: string;
  e: number;
  m: string;
  f: string;
}

/** `error.message` for a thrown value, which is not necessarily an Error. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reduce a caller-supplied mimetype to one that is safe to serve back as a response header.
 *
 * It reaches this file from the REST caller and leaves again as the `Content-Type` the engine reads.
 * A value carrying CR/LF would be header injection on that fetch, a non-latin1 value makes Node's
 * `res.set` throw ERR_INVALID_CHAR (a valid URL answering 500), and the service picks its WhatsApp
 * upload type from this header — so an unusable input is replaced outright rather than trimmed into
 * something that still looks authoritative. Normalised at ISSUE time, so the token can only ever carry
 * a value that is already inert when it is served.
 */
function normalizeMimetype(value: string): string {
  const candidate = value.trim();
  return MIMETYPE_PATTERN.test(candidate) ? candidate : EVOLUTION_GO_MEDIA_DEFAULT_MIMETYPE;
}

/**
 * The expiry a key carries, or null when it carries none.
 *
 * A key is `<prefix><epoch>-<uuid>`. The uuid contains hyphens of its own, so the parse anchors on the
 * leading digits and requires the separator immediately after them rather than splitting on every
 * hyphen and hoping the uuid never looks numeric.
 */
function expiryFromKey(key: string): number | null {
  const leaf = key.split(/[/\\]/).pop() ?? '';
  const match = /^(\d+)-/.exec(leaf);
  if (!match) return null;
  const expiry = Number(match[1]);
  return Number.isSafeInteger(expiry) && expiry > 0 ? expiry : null;
}

export class EvolutionGoMediaHost {
  private readonly logger: LoggerService = createLogger('EvolutionGoMediaHost');
  private readonly now: () => number;

  constructor(
    private readonly storage: StorageService,
    private readonly options: EvolutionGoMediaHostOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Whether a URL can be minted at all: a base URL the engine can actually reach, a key to sign with,
   * and a TTL that outlives the request that fetches it.
   *
   * `hostBuffer` requires all three so a misconfigured deployment fails the send with one actionable
   * message instead of minting a URL nothing can fetch. Verification asks only for the secret
   * ({@link hasSecret}): a replica that mints nothing must still serve what its peers minted.
   */
  isConfigured(): boolean {
    return (
      this.options.callbackBaseUrl.trim().length > 0 &&
      this.hasSecret() &&
      Number.isFinite(this.options.ttlSeconds) &&
      this.options.ttlSeconds > 0
    );
  }

  /**
   * Writes `buffer` to storage and returns the URL the engine should fetch.
   *
   * The key embeds the expiry (`<epoch>-<uuid>`) so the sweep needs no metadata. The uuid is what
   * makes two calls for the SAME bytes produce two different keys and two different tokens: the URL is
   * handed to a service we do not control, and a reused one would let an earlier send's expiry — and an
   * earlier send's blob — govern a later one.
   */
  async hostBuffer(options: EvolutionGoHostBufferOptions): Promise<string> {
    if (!this.isConfigured()) {
      throw new EngineTransportError(
        'Cannot host outbound media for Evolution Go: the media host is not configured. Set ' +
          'EVOLUTION_GO_CALLBACK_BASE_URL to the address the engine container reaches this gateway on, ' +
          'give it a non-empty secret, and check EVOLUTION_GO_MEDIA_TTL_SECONDS.',
      );
    }

    const expiresAt = this.expiryFromNow();
    const storageKey = `${EVOLUTION_GO_MEDIA_KEY_PREFIX}${expiresAt}-${randomUUID()}`;
    await this.storage.putFile(storageKey, options.buffer);

    const token = this.issueToken({
      v: TOKEN_VERSION,
      s: options.sessionId,
      k: storageKey,
      e: expiresAt,
      m: normalizeMimetype(options.mimetype),
      f: options.filename,
    });

    return `${this.baseUrl()}${EVOLUTION_GO_MEDIA_URL_PATH}/${token}`;
  }

  /**
   * The descriptor a token carries, or null when it is not one this host issued and has not expired.
   *
   * ONE null covers every rejection — bad shape, bad signature, unknown version, expired — because the
   * caller is a public route and the reason is not its business: telling a forger that the signature was
   * right but the clock ran out is free information about a token they can then go and fix. The
   * signature is checked BEFORE the payload is parsed, so nothing an unauthenticated caller wrote is
   * ever interpreted, not even to decide what to log.
   */
  readToken(token: string): EvolutionGoMediaDescriptor | null {
    if (!this.hasSecret() || token.length === 0) return null;

    const parts = token.split(TOKEN_SEPARATOR);
    if (parts.length !== 2) return null;
    const [encodedPayload, signature] = parts;
    if (encodedPayload.length === 0 || signature.length === 0) return null;
    if (!this.signatureMatches(encodedPayload, signature)) return null;

    const payload = this.decodePayload(encodedPayload);
    if (!payload) return null;
    // Half-open: valid while now < expiry. A token is never servable for even one second past the TTL
    // the operator configured.
    if (this.nowSeconds() >= payload.e) return null;

    return {
      sessionId: payload.s,
      storageKey: payload.k,
      expiresAt: payload.e,
      mimetype: payload.m,
      filename: payload.f,
    };
  }

  /**
   * Deletes every blob under the prefix whose expiry has passed, and reports how many it removed.
   *
   * The listing is `iterateFiles(prefix)`, not `listFiles()`: the latter stops at
   * STORAGE_LIST_MAX_FILES and is a per-call DoS guard rather than a completeness contract, so a sweep
   * built on it would silently stop reclaiming once the store outgrew the cap — the one failure a
   * reclaimer must not have.
   *
   * Nothing here runs on a timer, and there is no cleanup route either. A timer inside this class would
   * fire on every replica and would not survive a restart, and a delete route would put an unauthenticated
   * @Public surface in front of the store; the interval that matters belongs to whoever owns the
   * lifecycle and calls this.
   */
  async sweepExpired(): Promise<number> {
    const nowSeconds = this.nowSeconds();
    let removed = 0;
    let unparsable = 0;

    for await (const key of this.storage.iterateFiles(EVOLUTION_GO_MEDIA_KEY_PREFIX)) {
      const expiry = expiryFromKey(key);
      if (expiry === null) {
        // Never a key this class wrote. Left in place deliberately: mid-rollout an older sweeper must
        // not delete blobs a newer format has just created, and a name with no expiry in it is not
        // evidence that one has passed. The warning below is what keeps it from being invisible.
        unparsable += 1;
        continue;
      }
      if (expiry > nowSeconds) continue;
      try {
        await this.storage.deleteFile(key);
        removed += 1;
      } catch (error) {
        // One failed delete must not abort the sweep: every other expired blob is garbage whether or
        // not this one could be removed, and a storage hiccup on one object says nothing about the
        // rest. The next sweep retries it.
        this.logger.warn(`Failed to sweep expired Evolution Go media '${key}': ${describeError(error)}`);
      }
    }

    if (unparsable > 0) {
      this.logger.warn(
        `${unparsable} key(s) under '${EVOLUTION_GO_MEDIA_KEY_PREFIX}' carry no expiry and were left in place`,
      );
    }
    return removed;
  }

  /**
   * Whether there is a key to sign with at all.
   *
   * Public because the sweeper asks before arming its timer — a deployment that never configures this
   * engine should not walk the store every few minutes. Emptiness is fatal to verification too: an
   * empty HMAC key makes every signature reproducible by anyone, so an unconfigured host refuses every
   * token rather than treating the empty key as a wildcard.
   */
  hasSecret(): boolean {
    return this.options.secret.length > 0;
  }

  /** Whole seconds, floored: truncation can only SHORTEN a TTL by under a second, never extend one. */
  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  private expiryFromNow(): number {
    return this.nowSeconds() + Math.floor(this.options.ttlSeconds);
  }

  /** Trailing slashes trimmed so a configured base ending in '/' does not produce a doubled path. */
  private baseUrl(): string {
    return this.options.callbackBaseUrl.trim().replace(/\/+$/, '');
  }

  /**
   * Signs the ENCODED payload rather than the object it came from, so the signature covers exactly the
   * bytes that travel: no re-serialization — key order, spacing, a number rendered differently — can
   * make issuer and verifier disagree about what was signed.
   */
  private issueToken(payload: EvolutionGoMediaTokenPayload): string {
    const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${encodedPayload}${TOKEN_SEPARATOR}${this.sign(encodedPayload)}`;
  }

  private sign(encodedPayload: string): string {
    return createHmac(TOKEN_ALGORITHM, this.options.secret).update(encodedPayload).digest('base64url');
  }

  /**
   * Constant-time signature comparison.
   *
   * Length is compared first — not secret, fixed by the digest, and `timingSafeEqual` throws on a
   * mismatch, so the guard is required rather than an optimization. Everything else goes through
   * `timingSafeEqual`: `===` on the two base64 strings would report, byte by byte, how much of a
   * guessed signature was right, which is exactly the feedback a forger needs to finish the job.
   */
  private signatureMatches(encodedPayload: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(encodedPayload), 'base64url');
    const provided = Buffer.from(signature, 'base64url');
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  }

  /**
   * Parse and shape-check an already-VERIFIED payload.
   *
   * The key is required to sit under this host's own prefix: the token is signed, but if the secret
   * ever leaked, a token minted with it would otherwise name any object in the store — turning a
   * media-fetch credential into a read of everything the deployment keeps.
   */
  private decodePayload(encodedPayload: string): EvolutionGoMediaTokenPayload | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
      // Signed by us and still not JSON: only reachable from a hand-built token, and there is nothing
      // in it to recover.
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;

    const candidate = parsed as Record<string, unknown>;
    if (candidate.v !== TOKEN_VERSION) return null;
    if (typeof candidate.s !== 'string' || candidate.s.length === 0) return null;
    if (typeof candidate.k !== 'string' || !candidate.k.startsWith(EVOLUTION_GO_MEDIA_KEY_PREFIX)) return null;
    if (typeof candidate.e !== 'number' || !Number.isSafeInteger(candidate.e)) return null;
    if (typeof candidate.m !== 'string' || candidate.m.length === 0) return null;
    // The filename may legitimately be empty — the caller sent no name — so only its type is checked;
    // the controller substitutes a fallback when it builds the header.
    if (typeof candidate.f !== 'string') return null;

    return {
      v: TOKEN_VERSION,
      s: candidate.s,
      k: candidate.k,
      e: candidate.e,
      m: candidate.m,
      f: candidate.f,
    };
  }
}
