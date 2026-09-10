/**
 * HTTP client for the Evolution Go engine service.
 *
 * This is the whole transport layer for the `evolution-go` engine: unlike the two library engines,
 * nothing here speaks the WhatsApp protocol. The service does. What this file owns is the parts that
 * are easy to get subtly wrong:
 *
 *  - **Two credential levels.** Instance management (create/delete/list) authenticates with the
 *    GLOBAL key; everything scoped to a session authenticates with that INSTANCE's own token. Sending
 *    the global key where an instance token belongs is accepted by some deployments and not others,
 *    so the distinction is explicit in the API rather than implicit in a default.
 *  - **Error classification.** A transport failure and a WhatsApp-side refusal are different answers
 *    to the caller (503 vs 403), and collapsing them is how an operator ends up debugging the wrong
 *    layer. Every failure mode is mapped here, once.
 *  - **Deadlines.** Media sends legitimately take minutes (the service downloads the URL, encrypts
 *    and uploads inside the request), while every other call should fail fast. One timeout would have
 *    to be wrong for one of those groups, so the caller picks per request.
 */

import { request } from 'undici';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { createLogger, LoggerService } from '../../common/services/logger.service';

/** The service's own envelope: every JSON response wraps its payload in `data`. */
interface EvolutionGoEnvelope<T> {
  data?: T;
  message?: string;
}

/**
 * A 4xx the engine answered with something other than an auth refusal — most often 404 because the
 * named instance, chat or message does not exist on the remote side.
 *
 * Deliberately NOT mapped onto a NestJS exception here: whether "not found" is `null`, an empty
 * list, or a 404 is a per-method decision in the adapter (IWhatsAppEngine returns `null`/fallbacks
 * for several reads), so this carries the status and lets each caller decide. Auth refusals and
 * transport failures are mapped because those mean the same thing for every method.
 */
export class EvolutionGoHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Evolution Go ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = 'EvolutionGoHttpError';
  }
}

export interface EvolutionGoClientOptions {
  baseUrl: string;
  /** Global key, used for instance management. */
  apiKey: string;
  /** Deadline for ordinary calls. */
  timeoutMs: number;
  /** Deadline for media sends and stickers. */
  mediaTimeoutMs: number;
}

export interface EvolutionGoRequestOptions {
  /** Per-instance token. Omit to authenticate with the global key. */
  apiKey?: string;
  body?: unknown;
  /** Overrides the default deadline for this call. */
  timeoutMs?: number;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Body returned by the service for anything it refused; kept short for log messages. */
const MAX_ERROR_BODY = 300;

export class EvolutionGoClient {
  private readonly logger: LoggerService = createLogger('EvolutionGoClient');

  constructor(private readonly options: EvolutionGoClientOptions) {}

  /**
   * True when the client has enough configuration to be used at all. The adapter probes this before
   * a session starts so a missing URL/key fails with one clear message instead of every call
   * failing separately with a 401.
   */
  isConfigured(): boolean {
    return this.options.baseUrl.length > 0 && this.options.apiKey.length > 0;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  get mediaTimeoutMs(): number {
    return this.options.mediaTimeoutMs;
  }

  async get<T>(path: string, options: EvolutionGoRequestOptions = {}): Promise<T> {
    return this.requestVia<T>('GET', path, options);
  }

  async post<T>(path: string, options: EvolutionGoRequestOptions = {}): Promise<T> {
    return this.requestVia<T>('POST', path, options);
  }

  async put<T>(path: string, options: EvolutionGoRequestOptions = {}): Promise<T> {
    return this.requestVia<T>('PUT', path, options);
  }

  async delete<T>(path: string, options: EvolutionGoRequestOptions = {}): Promise<T> {
    return this.requestVia<T>('DELETE', path, options);
  }

  /**
   * Issues one request and unwraps the `data` field.
   *
   * Returns `undefined` (not `null`) when the service answered successfully without a `data` key,
   * which several endpoints do for writes that have nothing to report. Callers that need a value
   * treat that as "the service confirmed but said nothing", which is a different case from a
   * failure and is why it is not an error here.
   */
  async requestVia<T>(method: HttpMethod, path: string, options: EvolutionGoRequestOptions = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
    const apiKey = options.apiKey ?? this.options.apiKey;

    if (!apiKey) {
      throw new EngineTransportError(
        "Evolution Go is not configured: no API key. Set EVOLUTION_GO_API_KEY to the engine deployment's global key.",
      );
    }

    const url = `${this.options.baseUrl.replace(/\/+$/, '')}${path}`;
    const headers: Record<string, string> = { apikey: apiKey };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response;
    try {
      response = await request(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        // undici's own deadline. It covers connect + response headers + body, so a slow media send
        // is bounded by the caller-chosen media deadline rather than by a global constant.
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
    } catch (error) {
      // Network-level failure: the service is down, unreachable, or did not answer in time. This is
      // a 503 for the caller — never a "not found", which is what a broad catch would turn it into.
      const detail = error instanceof Error ? error.message : String(error);
      throw new EngineTransportError(
        `Evolution Go is unreachable at ${this.options.baseUrl} (${method} ${path}): ${detail}`,
      );
    }

    const text = await response.body.text();

    if (response.statusCode >= 200 && response.statusCode < 300) {
      if (text.trim() === '') return undefined as T;
      let parsed: EvolutionGoEnvelope<T>;
      try {
        parsed = JSON.parse(text) as EvolutionGoEnvelope<T>;
      } catch {
        // A 2xx with a non-JSON body means something other than the engine answered — a proxy or a
        // login page. Treating it as success would silently discard the response.
        throw new EngineTransportError(
          `Evolution Go returned a non-JSON body for ${method} ${path} (is EVOLUTION_GO_URL pointing at the engine?)`,
        );
      }
      return parsed.data as T;
    }

    const body = text.slice(0, MAX_ERROR_BODY);

    // Auth refusal: the key or instance token is wrong. Mapped to 403 rather than surfaced raw so a
    // caller cannot mistake it for "the operation was refused by WhatsApp".
    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new EngineRefusedError(
        `Evolution Go refused the credentials for ${method} ${path} (HTTP ${response.statusCode}). Check EVOLUTION_GO_API_KEY and that the session's instance still exists.`,
      );
    }

    // 5xx is the service failing, not the request being wrong — a 503 the caller can retry.
    if (response.statusCode >= 500) {
      this.logger.warn(`Evolution Go ${response.statusCode} on ${method} ${path}: ${body}`);
      throw new EngineTransportError(`Evolution Go failed (${response.statusCode}) on ${method} ${path}: ${body}`);
    }

    // Any other 4xx is the caller's to interpret (usually "does not exist").
    throw new EvolutionGoHttpError(response.statusCode, `${method} ${path}`, body);
  }
}
