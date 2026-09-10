/**
 * Inbound webhook route for the Evolution Go engine.
 *
 * The engine service pushes events here per instance; this route receives them for EVERY session on
 * this deployment at once and routes each to the adapter that owns the named instance. It is the
 * only way inbound messages, QR codes and connection changes reach the rest of the application —
 * there is no socket to subscribe to.
 *
 * ## Why the route is public, and what guards it instead
 *
 * The caller is another container, which holds no OpenWA API key, so the route carries `@Public()`
 * (the fence `global-route-fence-coverage.spec.ts` recognises). What stands in for authentication is
 * a shared secret carried in the path and compared in constant time. That is mitigation, not strong
 * authentication: the engine's webhook has no signature and no HMAC to verify, so the secret is the
 * only thing between a caller on the docker network and forged session events — and a forged inbound
 * message is indistinguishable from a real one downstream. The route is therefore expected to stay on
 * the internal network. An unset secret refuses everything rather than accepting everything.
 */

import { timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../modules/auth/decorators/auth.decorators';
import { EngineRegistry } from '../engine-registry.service';
import type { EvolutionGoAdapter } from './evolution-go.adapter';
import { dispatchRemoteEvent } from './evolution-go-events';

/** Structural test for "this engine is the Evolution Go adapter", so the registry stays engine-agnostic. */
function isEvolutionGoEngine(engine: unknown): engine is EvolutionGoAdapter {
  return (
    typeof engine === 'object' &&
    engine !== null &&
    'matchesInstance' in engine &&
    typeof engine.matchesInstance === 'function'
  );
}

/**
 * Constant-time comparison of the path secret.
 *
 * Length is checked first because `timingSafeEqual` throws on differing lengths — and a length check
 * leaks only the length, which the shared secret's entropy makes uninteresting. Comparing with `===`
 * instead would leak the secret prefix one byte at a time to anyone who can time the route.
 */
function secretMatches(provided: string, expected: string): boolean {
  if (expected.length === 0) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function pickString(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

@Controller('engine/evolution-go')
export class EvolutionGoIngressController {
  private readonly logger = new Logger(EvolutionGoIngressController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly engineRegistry: EngineRegistry,
  ) {}

  @Post('webhook/:secret')
  @Public()
  @HttpCode(200)
  webhook(@Param('secret') secret: string, @Body() body: Record<string, unknown>): { status: string; reason?: string } {
    const expected = this.configService.get<string>('engine.evolutionGo.ingressSecret') ?? '';
    // 404 rather than 401: an unauthenticated caller should not learn that the route exists.
    if (!secretMatches(secret ?? '', expected)) {
      throw new NotFoundException();
    }

    if (typeof body !== 'object' || body === null) {
      throw new BadRequestException('Expected a JSON object');
    }

    const event = pickString(body, 'event', 'Event', 'type', 'Type') ?? '';
    const instanceName = pickString(body, 'instanceName', 'InstanceName', 'instance', 'Instance') ?? '';
    if (!instanceName) {
      // Nothing to route on. Answered 200 so the service does not retry an event that can never be
      // routed; the log line is what makes the misconfiguration visible.
      this.logger.warn('Evolution Go webhook arrived with no instance name');
      return { status: 'ignored', reason: 'no_instance' };
    }

    const adapter = this.findAdapter(instanceName);
    if (!adapter) {
      // A session that has been stopped, or an instance left over from a previous deployment. Not an
      // error: the same 200-without-retry reasoning as above, plus the reconciler will clean it up.
      this.logger.debug(`Evolution Go event '${event}' for unknown instance '${instanceName}'`);
      return { status: 'ignored', reason: 'unknown_instance' };
    }

    const handled = dispatchRemoteEvent(adapter, event, body);
    if (!handled) {
      this.logger.debug(`Evolution Go event '${event}' is not mapped; dropped`);
    }
    return { status: handled ? 'ok' : 'ignored', reason: handled ? undefined : 'unhandled_event' };
  }

  /**
   * Finds the live adapter owning a remote instance name.
   *
   * Resolution is keyed on the instance name rather than the session id because that is all the
   * webhook carries, and the naming rule lives in the adapter (see `matchesInstance`). The liveness
   * check is the same identity check every other engine callback path uses: a superseded or stopped
   * adapter must not receive events for the session its replacement now owns.
   */
  private findAdapter(instanceName: string): EvolutionGoAdapter | undefined {
    for (const [sessionId, engine] of this.engineRegistry.entries()) {
      if (!isEvolutionGoEngine(engine)) continue;
      if (!this.engineRegistry.isLive(sessionId, engine)) continue;
      if (engine.matchesInstance(instanceName)) return engine;
    }
    return undefined;
  }
}
