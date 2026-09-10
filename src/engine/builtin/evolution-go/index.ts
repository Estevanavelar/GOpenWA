/**
 * Evolution Go Engine Plugin
 * Built-in engine plugin that backs IWhatsAppEngine with an external Evolution Go service.
 *
 * Unlike the two library engines this plugin holds no library handle: the "engine" is an HTTP API
 * somewhere else. What it needs from the operator is therefore connection information rather than
 * launch options, and it reads that from the same opaque `engine` config blob the factory supplies
 * to every plugin — see `engine.evolutionGo` in src/config/configuration.ts.
 */

import { PluginContext, PluginType, IEnginePlugin } from '../../../core/plugins';
import { IWhatsAppEngine } from '../../interfaces/whatsapp-engine.interface';
import { EvolutionGoAdapter, type EvolutionGoEngineConfig, type MediaHost } from '../../adapters/evolution-go.adapter';

/** The service version this adapter's request/response mapping was written against. */
export const EVOLUTION_GO_VERSION = '0.7.2';

export class EvolutionGoPlugin implements IEnginePlugin {
  type = PluginType.ENGINE as const;
  private context?: PluginContext;

  /**
   * `registeredConfig` mirrors the two sibling plugins: the engine config blob is supplied at
   * construction as well, so `createEngine` still has operator config when `enablePlugin` failed
   * before `onLoad` ran (this.context stays unset). The healthy path prefers `context.config`,
   * which carries any persisted override merged on top.
   *
   * `mediaHost` is injected rather than constructed here because hosting outbound bytes needs the
   * application's storage service, which a plugin has no way to reach.
   */
  constructor(
    private readonly registeredConfig?: Record<string, unknown>,
    private readonly mediaHost?: MediaHost,
  ) {}

  onLoad(context: PluginContext): Promise<void> {
    this.context = context;
    context.logger.log('Evolution Go engine plugin loaded');
    return Promise.resolve();
  }

  onEnable(context: PluginContext): Promise<void> {
    // An unset secret would make every webhook 404 and leave the session silently mute: connected,
    // sending, but never receiving. Refusing here surfaces it at the moment the engine is selected
    // instead of the first time someone messages the account.
    const config = this.readConfig(context.config ?? this.registeredConfig ?? {});
    if (!config.ingressSecret) {
      return Promise.reject(
        new Error(
          "Evolution Go requires EVOLUTION_GO_INGRESS_SECRET: the engine's webhook is unsigned, so without it the ingress refuses every event and inbound messages never arrive.",
        ),
      );
    }
    context.logger.log('Evolution Go engine plugin enabled');
    return Promise.resolve();
  }

  onDisable(context: PluginContext): Promise<void> {
    context.logger.log('Evolution Go engine plugin disabled');
    return Promise.resolve();
  }

  createEngine(config: Record<string, unknown>): IWhatsAppEngine {
    const sessionId = config.sessionId as string;
    const dbSessionId = config.dbSessionId as string;
    const proxyUrl = config.proxyUrl as string | undefined;
    const proxyType = config.proxyType as 'http' | 'https' | 'socks4' | 'socks5' | undefined;

    // Per-call config carries only engine-neutral fields (the factory's own spec pins that), so
    // everything specific to this engine is read off its namespace in the opaque blob.
    const engineConfig = this.context?.config ?? this.registeredConfig ?? {};

    return new EvolutionGoAdapter({
      sessionId,
      dbSessionId,
      proxyUrl,
      proxyType,
      config: this.readConfig(engineConfig),
      mediaHost: this.mediaHost,
    });
  }

  /** Fills defaults for every field, so a partially-configured deployment fails on the field it
   *  actually got wrong rather than on `undefined` propagating through a URL. */
  private readConfig(raw: unknown): EvolutionGoEngineConfig {
    // Takes `unknown` and narrows here rather than at each of the three call sites, which otherwise
    // each need their own cast to reach a field of an opaque config blob.
    const blob = (typeof raw === 'object' && raw !== null ? raw : {}) as {
      evolutionGo?: Partial<EvolutionGoEngineConfig>;
    };
    const evolutionGo = blob.evolutionGo ?? {};
    return {
      baseUrl: evolutionGo.baseUrl ?? '',
      apiKey: evolutionGo.apiKey ?? '',
      callbackBaseUrl: evolutionGo.callbackBaseUrl ?? '',
      ingressSecret: evolutionGo.ingressSecret ?? '',
      instancePrefix: evolutionGo.instancePrefix ?? 'openwa-',
      stateDir: evolutionGo.stateDir ?? './data/evolution-go',
      timeoutMs: evolutionGo.timeoutMs ?? 30000,
      mediaTimeoutMs: evolutionGo.mediaTimeoutMs ?? 120000,
      mediaTtlSeconds: evolutionGo.mediaTtlSeconds ?? 300,
      subscribe: evolutionGo.subscribe ?? [],
    };
  }

  /**
   * Only the capabilities this adapter actually wires.
   *
   * Deliberately shorter than the sibling engines' lists: advertising a capability the remote API
   * cannot serve would push a caller into a 501 it had no way to predict from the dashboard.
   */
  getFeatures(): string[] {
    return [
      'text-messages',
      'media-messages',
      'location-messages',
      'contact-messages',
      'sticker-messages',
      'poll-messages',
      'message-replies',
      'message-reactions',
      'message-editing',
      'message-deletion',
      'read-receipts',
      'typing-indicator',
      'chat-archive',
      'chat-pin',
      'chat-mute',
      'group-management',
      'labels',
      'newsletter-channels',
      'status-posting',
      'call-rejection',
      'proxy-per-session',
    ];
  }

  getEngineLibrary(): { name: string; version: string } {
    // Not an npm package, so there is no installed version to read: this reports the service
    // release the adapter's mapping targets, which is what the dashboard should show.
    return { name: 'evolution-go', version: EVOLUTION_GO_VERSION };
  }

  /**
   * A cheap reachability probe, not a full session check — the plugin has no session to check.
   * Reports unhealthy rather than throwing so the dashboard can render the state.
   */
  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    const config = this.readConfig(this.context?.config ?? this.registeredConfig ?? {});
    if (!config.baseUrl || !config.apiKey) {
      return { healthy: false, message: 'EVOLUTION_GO_URL and EVOLUTION_GO_API_KEY are required.' };
    }
    try {
      const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/instance/all`, {
        headers: { apikey: config.apiKey },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        return { healthy: false, message: `Evolution Go answered HTTP ${response.status}.` };
      }
      return { healthy: true, message: 'Evolution Go is reachable' };
    } catch (error) {
      return {
        healthy: false,
        message: `Evolution Go is unreachable at ${config.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

export default EvolutionGoPlugin;
