import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { config } from "./config";
import { HttpErrorsFilter } from "./http/http-errors.filter";
import { createOrm } from "./infra/db/orm";
import { createSqsClient, ensureQueues } from "./infra/sqs/sqs";
import { log } from "./observability/logger";

const orm = await createOrm();
const sqs = createSqsClient();
const queues = await ensureQueues(sqs);

const app = await NestFactory.create(AppModule.register({ orm, sqs, queues }), { logger: ["error", "warn"] });
app.useGlobalFilters(new HttpErrorsFilter());
app.enableShutdownHooks(["SIGTERM", "SIGINT"]);
await app.listen(config.port);
log.info("listening", { port: config.port });