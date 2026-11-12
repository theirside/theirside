import { randomUUID } from 'node:crypto';
import { HttpModule } from '@nestjs/axios';
import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { shutdown } from '@theirside/sdk';
import { ClsModule } from 'nestjs-cls';
import { DemoController } from './demo.controller';
import { WebhooksController } from './webhooks.controller';
import {
  AcmeCardsClient,
  BankCoClient,
  GeoApiClient,
  InternalClients,
  KycoClient,
  NotifyCoClient,
  SaasCoClient,
} from './providers';

/** Flush queued events when Nest shuts down (enableShutdownHooks in main.ts). */
@Injectable()
class MonitorShutdown implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await shutdown();
  }
}

@Module({
  imports: [
    HttpModule,
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: { headers: Record<string, string | string[] | undefined> }) =>
          String(req.headers['x-request-id'] ?? randomUUID()),
      },
    }),
  ],
  controllers: [DemoController, WebhooksController],
  providers: [
    AcmeCardsClient,
    KycoClient,
    BankCoClient,
    NotifyCoClient,
    SaasCoClient,
    GeoApiClient,
    InternalClients,
    MonitorShutdown,
  ],
})
export class AppModule {}
