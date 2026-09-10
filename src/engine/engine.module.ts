import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EngineFactory } from './engine.factory';
import { BaileysStoredMessage } from './adapters/baileys-stored-message.entity';
import { BaileysMessageStoreService } from './adapters/baileys-message-store.service';
import { LidMapping } from './identity/lid-mapping.entity';
import { LidMappingStoreService } from './identity/lid-mapping-store.service';
import { ChatState } from './adapters/baileys-chat-state.entity';
import { ChatStateStoreService } from './adapters/baileys-chat-state-store.service';
import { EngineRegistry } from './engine-registry.service';
import { EvolutionGoIngressController } from './adapters/evolution-go-ingress.controller';
import { EvolutionGoMediaController } from './adapters/evolution-go-media.controller';
import { EvolutionGoMediaHost } from './adapters/evolution-go-media-host';
import { EvolutionGoMediaSweeper } from './adapters/evolution-go-media-sweeper';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../common/storage/storage.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([BaileysStoredMessage, LidMapping, ChatState], 'data')],
  // The Evolution Go ingress lives here rather than in a feature module because it is engine
  // plumbing: it routes a remote service's webhook to the live adapter, and nothing else in the
  // application has a reason to know that route exists.
  controllers: [EvolutionGoIngressController, EvolutionGoMediaController],
  // EngineRegistry is exported from this @Global module so the feature services that only need a
  // live engine can inject it directly, instead of importing SessionModule to reach the lifecycle
  // owner. It is a singleton by DI, which is what makes it a safe single source of truth.
  providers: [
    EngineFactory,
    BaileysMessageStoreService,
    LidMappingStoreService,
    ChatStateStoreService,
    EngineRegistry,
    // Built from config rather than class-injected: the host takes its callback base URL, signing
    // secret and TTL as plain options, and ConfigService is the only thing that knows them. StorageService
    // arrives from the @Global StorageModule, so no import is needed for it.
    {
      provide: EvolutionGoMediaHost,
      inject: [ConfigService, StorageService],
      useFactory: (configService: ConfigService, storage: StorageService): EvolutionGoMediaHost =>
        new EvolutionGoMediaHost(storage, {
          callbackBaseUrl: configService.get<string>('engine.evolutionGo.callbackBaseUrl') ?? '',
          secret: configService.get<string>('engine.evolutionGo.ingressSecret') ?? '',
          ttlSeconds: configService.get<number>('engine.evolutionGo.mediaTtlSeconds') ?? 300,
        }),
    },
    EvolutionGoMediaSweeper,
  ],
  exports: [EngineFactory, LidMappingStoreService, ChatStateStoreService, EngineRegistry, EvolutionGoMediaHost],
})
export class EngineModule {}
