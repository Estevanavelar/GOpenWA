import * as fs from 'fs';
import * as path from 'path';
import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IWhatsAppEngine } from './interfaces/whatsapp-engine.interface';
import { WhatsAppWebJsAdapter } from './adapters/whatsapp-web-js.adapter';
import { PluginLoaderService, PluginType, IEnginePlugin, PluginManifest } from '../core/plugins';
import { WhatsAppWebJsPlugin } from './builtin/whatsapp-web-js';
import { BaileysPlugin } from './builtin/baileys';
import { EvolutionGoPlugin } from './builtin/evolution-go';
import { createLogger } from '../common/services/logger.service';
import { BaileysMessageStoreService } from './adapters/baileys-message-store.service';
import { LidMappingStoreService } from './identity/lid-mapping-store.service';
import { ChatStateStoreService } from './adapters/baileys-chat-state-store.service';
import { isSafeSessionName } from '../common/utils/path-safety';
import { ensurePrivateDir } from '../common/utils/private-dir.util';
import { EvolutionGoMediaHost } from './adapters/evolution-go-media-host';
import type { MediaHost } from './adapters/evolution-go.adapter';

export interface EngineCreateOptions {
  /** Session NAME — the on-disk auth-directory key (matches the dirs purgeSessionData removes). */
  sessionId: string;
  /** Session UUID (Session.id) — the DB-row key for FK-bound stores (e.g. baileys_stored_messages). */
  dbSessionId: string;
  proxyUrl?: string;
  proxyType?: 'http' | 'https' | 'socks4' | 'socks5';
}

@Injectable()
export class EngineFactory implements OnModuleInit {
  private readonly logger = createLogger('EngineFactory');
  private readonly engineType: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly pluginLoader: PluginLoaderService,
    private readonly baileysMessageStore: BaileysMessageStoreService,
    private readonly lidMappingStore: LidMappingStoreService,
    private readonly chatStateStore: ChatStateStoreService,
    /**
     * Hosts outbound bytes for engines whose service fetches media by URL rather than accepting the
     * payload inline. The Evolution Go engine reports a clear transport error if it is asked to send
     * base64 media without one, rather than silently dropping the media.
     *
     * Injected by EXPLICIT token, and optional. The parameter is typed as the structural
     * {@link MediaHost} interface, and `emitDecoratorMetadata` emits a type-only import as `Object` —
     * which Nest then tries to resolve as a provider and fails, taking application boot down with an
     * UnknownDependenciesException. The token removes the guesswork; `@Optional()` keeps the factory
     * constructible with five arguments, which is how its spec builds it.
     */
    @Optional()
    @Inject(EvolutionGoMediaHost)
    private readonly mediaHost?: MediaHost,
  ) {
    this.engineType = this.configService.get<string>('engine.type') ?? 'whatsapp-web.js';
  }

  async onModuleInit(): Promise<void> {
    // Register built-in engine plugins
    await this.registerBuiltInEngines();
  }

  private async registerBuiltInEngines(): Promise<void> {
    // The engine config sub-tree (engine.* from configuration.ts) as an opaque blob. Supplied BOTH
    // to registerBuiltInPlugin (becomes context.config when onLoad runs) AND to each plugin's
    // constructor (A fallback so createEngine still has operator config if enablePlugin fails
    // before onLoad — otherwise sessionDataPath/executablePath/authDir would silently drop to defaults).
    const engineConfig = this.configService.get<Record<string, unknown>>('engine') ?? {};

    // Register WhatsApp-web.js as built-in plugin
    const wwjsManifest: PluginManifest = {
      id: 'whatsapp-web.js',
      name: 'WhatsApp Web.js Engine',
      version: '1.0.0',
      type: PluginType.ENGINE,
      description: 'Official WhatsApp-web.js engine adapter',
      main: 'index.ts',
      provides: ['whatsapp-engine'],
    };

    const wwjsPlugin = new WhatsAppWebJsPlugin(engineConfig, this.lidMappingStore);
    this.pluginLoader.registerBuiltInPlugin(wwjsManifest, wwjsPlugin, engineConfig);

    // Register Baileys as a second built-in engine plugin. Same opaque engine blob; the plugin
    // reads only its own namespace (baileys.authDir) from context.config.
    const baileysManifest: PluginManifest = {
      id: 'baileys',
      name: 'Baileys Engine',
      version: '1.0.0',
      type: PluginType.ENGINE,
      description: 'Baileys (WebSocket, no-browser) engine adapter',
      main: 'index.ts',
      provides: ['whatsapp-engine'],
    };
    this.pluginLoader.registerBuiltInPlugin(
      baileysManifest,
      new BaileysPlugin(this.baileysMessageStore, engineConfig, this.lidMappingStore, this.chatStateStore),
      engineConfig,
    );

    // Register Evolution Go as a third built-in engine plugin. Same opaque engine blob; the plugin
    // reads only its own namespace (engine.evolutionGo). The media host is injected because hosting
    // outbound bytes needs the application's storage service, which a plugin cannot reach.
    const evolutionGoManifest: PluginManifest = {
      id: 'evolution-go',
      name: 'Evolution Go Engine',
      version: '1.0.0',
      type: PluginType.ENGINE,
      description: 'External Evolution Go service engine adapter (HTTP client, no browser)',
      main: 'index.ts',
      provides: ['whatsapp-engine'],
    };
    this.pluginLoader.registerBuiltInPlugin(
      evolutionGoManifest,
      new EvolutionGoPlugin(engineConfig, this.mediaHost),
      engineConfig,
    );

    // Auto-enable the configured engine
    try {
      await this.pluginLoader.enablePlugin(this.engineType);
      this.logger.log(`Engine plugin enabled: ${this.engineType}`, {
        action: 'engine_enabled',
        engineType: this.engineType,
      });
    } catch (error) {
      this.logger.error(
        `Failed to enable engine plugin: ${this.engineType}`,
        error instanceof Error ? error.message : String(error),
        { action: 'engine_enable_failed' },
      );
    }
  }

  create(options: EngineCreateOptions): IWhatsAppEngine {
    // The sessionId becomes the engine's on-disk auth-directory key (path.join(authDir, sessionId) /
    // session-${sessionId}), so a name containing '.', '/' or '\\' could traverse outside it. Normal
    // creation validates via CreateSessionDto, but alternate paths (data import, seed) can reach this
    // sink with a raw name — assert here so the traversal can never materialize regardless of source.
    if (!isSafeSessionName(options.sessionId)) {
      throw new Error(`Refusing to create an engine for an unsafe session name: ${JSON.stringify(options.sessionId)}`);
    }

    // Both engine shapes' credential dirs are made owner-only up front, whichever engine this
    // session runs and whichever construction path serves it (plugin or fallback): a whatsapp-web.js
    // profile and a baileys creds.json each hold everything needed to take over the linked account,
    // so read access to the data volume must not be enough. Mirrors purgeSessionData, which removes
    // BOTH shapes for the same engine-switch-residue reason.
    ensurePrivateDir(this.wwjsAuthDir(options.sessionId));
    ensurePrivateDir(this.baileysAuthDir(options.sessionId));

    // Try to get engine from plugin system
    const enginePlugin = this.pluginLoader.getPlugin(this.engineType);

    if (enginePlugin?.instance && this.isEnginePlugin(enginePlugin.instance)) {
      // Engine-neutral per-call config only. Engine-specific config (e.g. Puppeteer for
      // whatsapp-web.js) is supplied to the plugin as an opaque blob via context.config at
      // registration, so the factory never assembles browser-shaped fields.
      return enginePlugin.instance.createEngine({
        sessionId: options.sessionId,
        dbSessionId: options.dbSessionId,
        proxyUrl: options.proxyUrl,
        proxyType: options.proxyType,
      }) as IWhatsAppEngine;
    }

    // Fallback to direct adapter creation (legacy support)
    this.logger.warn(`Engine plugin ${this.engineType} not available, using fallback`, {
      action: 'engine_fallback',
    });

    return this.createFallbackEngine(options);
  }

  /**
   * Remove a session's persistent on-disk auth/store directories so deleting a session fully purges
   * its footprint. The dir is keyed by session NAME — the same key {@link create} uses
   * (`path.join(authDir, name)` for baileys, `session-${name}` under sessionDataPath for
   * whatsapp-web.js) — and survives independently of any engine instance. On delete the engine is
   * frequently not even loaded (a stopped session has none), so the paths are derived from config
   * here rather than from a live adapter; otherwise recreating a session under the same name would
   * reload a stale store.
   *
   * BOTH engine shapes are purged, not just the active engine's: ENGINE_TYPE is a deploy-level
   * switch, so a session that ever ran under both engines leaves a live auth dir for each, and
   * removing only the active engine's would strand the other's WhatsApp credentials on disk after
   * "delete" — able to silently re-link if the engine is ever switched back (and carried into
   * backups). Each rm is isolated best-effort: an unsafe name is refused up front, and one engine's
   * rm failure is logged per-engine — it neither fails the delete nor skips the other engine's purge.
   *
   * Note: session START deliberately does NOT purge the inactive engine's residue. An operator
   * trialling the other engine keeps the previous engine's link so switching back doesn't force a
   * re-pair; the residue is removed only when the session itself is deleted.
   */
  async purgeSessionData(sessionName: string): Promise<void> {
    if (!isSafeSessionName(sessionName)) {
      // Same guard as create(): never let a name with '.', '/' or '\\' reach an rm -rf sink.
      this.logger.warn('Refusing to purge session data for an unsafe session name', {
        action: 'engine_purge_unsafe',
        sessionName: JSON.stringify(sessionName),
      });
      return;
    }
    const dirs: Array<{ engine: string; dir: string }> = [
      { engine: 'whatsapp-web.js', dir: this.wwjsAuthDir(sessionName) },
      { engine: 'baileys', dir: this.baileysAuthDir(sessionName) },
    ];
    for (const { engine, dir } of dirs) {
      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
        this.logger.log('Purged session auth directory', { action: 'engine_purge', engine, sessionName, dir });
      } catch (error) {
        this.logger.warn('Failed to purge session auth directory', {
          action: 'engine_purge_failed',
          engine,
          sessionName,
          dir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * The on-disk auth directory whatsapp-web.js keeps for `sessionName`, matching exactly what the
   * adapter constructs: sessionDataPath resolved, then `session-${name}` appended (mirrors
   * WhatsAppWebJsAdapter.clearLocalAuth).
   */
  private wwjsAuthDir(sessionName: string): string {
    const sessionDataPath = this.configService.get<string>('engine.sessionDataPath') ?? './data/sessions';
    return path.join(path.resolve(sessionDataPath), `session-${sessionName}`);
  }

  /**
   * The on-disk auth directory baileys keeps for `sessionName`: `path.join(authDir, name)`, with
   * authDir left unresolved, as the adapter does.
   */
  private baileysAuthDir(sessionName: string): string {
    const authDir = this.configService.get<string>('engine.baileys.authDir') ?? './data/baileys';
    return path.join(authDir, sessionName);
  }

  private isEnginePlugin(instance: unknown): instance is IEnginePlugin {
    return (
      typeof instance === 'object' &&
      instance !== null &&
      'type' in instance &&
      instance.type === PluginType.ENGINE &&
      'createEngine' in instance &&
      typeof (instance as { createEngine: unknown }).createEngine === 'function'
    );
  }

  private createFallbackEngine(options: EngineCreateOptions): IWhatsAppEngine {
    // This legacy fallback can only construct the whatsapp-web.js adapter. If a different engine was
    // requested (e.g. ENGINE_TYPE=baileys) and its plugin wasn't available, building wwebjs here would
    // silently run the WRONG engine — fail loudly so the misconfiguration is visible instead.
    if (this.engineType !== 'whatsapp-web.js') {
      throw new Error(
        `Engine '${this.engineType}' is unavailable and has no direct fallback; cannot start the session.`,
      );
    }

    // Legacy direct creation (fallback)
    return new WhatsAppWebJsAdapter({
      sessionId: options.sessionId,
      sessionDataPath: this.configService.get<string>('engine.sessionDataPath') ?? './data/sessions',
      puppeteer: {
        headless: this.configService.get<boolean>('engine.puppeteer.headless') ?? true,
        args: this.configService.get<string[]>('engine.puppeteer.args') ?? ['--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: this.configService.get<string>('engine.puppeteer.executablePath'),
        protocolTimeoutMs: this.configService.get<number>('engine.puppeteer.protocolTimeoutMs'),
      },
      proxy: options.proxyUrl
        ? {
            url: options.proxyUrl,
            type: options.proxyType ?? 'http',
          }
        : undefined,
      lidMappingStore: this.lidMappingStore,
    });
  }

  // ============================================================================
  // Query Methods for API/Dashboard
  // ============================================================================

  getAvailableEngines(): Array<{
    id: string;
    name: string;
    enabled: boolean;
    features: string[];
    library?: { name: string; version: string };
  }> {
    const enginePlugins = this.pluginLoader.getPluginsByType(PluginType.ENGINE);

    return enginePlugins.map(plugin => {
      const inst = plugin.instance;
      const features = inst && this.isEnginePlugin(inst) ? inst.getFeatures() : [];
      // The real underlying library version (e.g. whatsapp-web.js 1.34.7), distinct from the
      // plugin's manifest version — so the dashboard can show which engine is actually running.
      const library = inst && this.isEnginePlugin(inst) ? inst.getEngineLibrary?.() : undefined;

      return {
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        enabled: this.pluginLoader.isPluginEnabled(plugin.manifest.id),
        features,
        library,
      };
    });
  }

  getCurrentEngine(): string {
    return this.engineType;
  }
}
