import type { SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { type BeforeApplicationShutdown, type DynamicModule, Inject, Module, type OnApplicationBootstrap } from "@nestjs/common";
import { OutboxPublisher } from "./app/outbox.publisher";
import { PendingReferenceWorker } from "./app/pending-reference.worker";
import { ProcessWagerTransaction } from "./app/process-wager.use-case";
import { consumerOptions, WagerQueueConsumer } from "./app/wager-queue.consumer";
import { CreateWallet, ReconcileWallet, WalletQueries } from "./app/wallets.use-cases";
import { config } from "./config";
import { WageringController, WalletsController } from "./http/controllers";
import { HealthController } from "./http/health.controller";
import { TOKENS } from "./http/tokens";
import { log } from "./observability/logger";

type Queues = { main: string; dlq: string; events: string };

/** Starts the background loops with the app and stops them first on SIGTERM. */
class Workers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly consumer: WagerQueueConsumer;
  private readonly outbox: OutboxPublisher;
  private readonly pending: PendingReferenceWorker;

  constructor(
    @Inject(TOKENS.orm) private readonly orm: MikroORM,
    @Inject(TOKENS.sqs) sqs: SQSClient,
    @Inject(TOKENS.queues) queues: Queues,
    @Inject(TOKENS.processWager) processWager: ProcessWagerTransaction,
  ) {
    this.consumer = new WagerQueueConsumer(sqs, processWager, consumerOptions(queues));
    this.outbox = new OutboxPublisher(orm, sqs, queues.events);
    this.pending = new PendingReferenceWorker(orm);
  }

  onApplicationBootstrap() {
    if (config.workers.consumer) this.consumer.start();
    if (config.workers.outbox) this.outbox.start();
    if (config.workers.pendingReference) this.pending.start();
    log.info("workers started", { ...config.workers });
  }

  async beforeApplicationShutdown(signal?: string) {
    log.info("shutting down", { signal });
    await this.consumer.stop();
    await Promise.all([this.outbox.stop(), this.pending.stop()]);
    await this.orm.close();
    log.info("shutdown complete");
  }
}

@Module({})
export class AppModule {
  static register(deps: { orm: MikroORM; sqs: SQSClient; queues: Queues }): DynamicModule {
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController],
      providers: [
        { provide: TOKENS.orm, useValue: deps.orm },
        { provide: TOKENS.sqs, useValue: deps.sqs },
        { provide: TOKENS.queues, useValue: deps.queues },
        { provide: TOKENS.processWager, useValue: new ProcessWagerTransaction(deps.orm) },
        { provide: TOKENS.createWallet, useValue: new CreateWallet(deps.orm) },
        { provide: TOKENS.walletQueries, useValue: new WalletQueries(deps.orm) },
        { provide: TOKENS.reconcileWallet, useValue: new ReconcileWallet(deps.orm) },
        Workers,
      ],
    };
  }
}