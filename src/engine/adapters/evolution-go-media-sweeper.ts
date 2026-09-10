/**
 * Evicts expired outbound media blobs on a timer.
 *
 * The blobs {@link EvolutionGoMediaHost} writes are short-lived by design — the engine fetches one
 * synchronously inside the send call that minted it — but nothing deletes them once that call is
 * over. Without this, every base64 media send leaves a file behind forever, and the store grows with
 * traffic that has already been delivered.
 *
 * A timer rather than delete-on-read: the route that serves a blob cannot know whether the engine
 * succeeded in fetching it, and deleting on the first GET would break the engine's own retry of a
 * fetch that timed out half way. Expiry is the only signal that is actually safe to act on.
 *
 * Mirrors the interval/teardown shape the chat-media archive already uses, including the
 * `unref` that keeps the timer from holding the process open at shutdown.
 */

import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createLogger, LoggerService } from '../../common/services/logger.service';
import { EvolutionGoMediaHost } from './evolution-go-media-host';

/** How often the sweep runs. Comfortably shorter than any sane TTL, so blobs do not pile up. */
export const EVOLUTION_GO_MEDIA_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class EvolutionGoMediaSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger: LoggerService = createLogger('EvolutionGoMediaSweeper');
  private timer?: NodeJS.Timeout;
  /** Guards against a slow sweep overlapping the next tick's. */
  private running = false;

  constructor(private readonly mediaHost: EvolutionGoMediaHost) {}

  onModuleInit(): void {
    // Nothing to sweep when the host cannot mint URLs at all (the engine is not in use): skipping the
    // timer keeps a deployment that never selects this engine from listing the store every 5 minutes.
    if (!this.mediaHost.hasSecret()) return;
    this.timer = setInterval(() => void this.sweep(), EVOLUTION_GO_MEDIA_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const removed = await this.mediaHost.sweepExpired();
      if (removed > 0) {
        this.logger.log(`Removed ${removed} expired outbound media blob(s)`, {
          action: 'media_sweep',
        });
      }
    } catch (error) {
      // A failed sweep must never take the process down: the next tick retries, and the blobs it
      // would have deleted are harmless until then.
      this.logger.warn(`Outbound media sweep failed: ${error instanceof Error ? error.message : String(error)}`, {
        action: 'media_sweep_failed',
      });
    } finally {
      this.running = false;
    }
  }
}
