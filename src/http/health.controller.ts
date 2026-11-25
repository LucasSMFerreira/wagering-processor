import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { Response } from "express";
import { registry } from "../observability/metrics";
import { TOKENS } from "./tokens";

/** Open on purpose: no guard. */
@Controller()
export class HealthController {
  constructor(
    @Inject(TOKENS.orm) private readonly orm: MikroORM,
    @Inject(TOKENS.sqs) private readonly sqs: SQSClient,
    @Inject(TOKENS.queues) private readonly queues: { main: string },
  ) {}

  /** The process answers. Nothing else is checked: a restart would not fix a database outage. */
  @Get("health/live")
  live() {
    return { status: "ok" };
  }

  /** Can this instance do useful work right now? PostgreSQL and SQS must answer. */
  @Get("health/ready")
  async ready(@Res() res: Response) {
    const timeout = <T>(p: Promise<T>) =>
      Promise.race([p, Bun.sleep(2000).then(() => Promise.reject(new Error("timeout")))]);
    const [db, sqs] = await Promise.allSettled([
      timeout(this.orm.em.getConnection().execute("select 1")),
      timeout(this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: this.queues.main, AttributeNames: ["QueueArn"] }))),
    ]);
    const checks = { postgres: db.status === "fulfilled" ? "up" : "down", sqs: sqs.status === "fulfilled" ? "up" : "down" };
    const ok = checks.postgres === "up" && checks.sqs === "up";
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "unavailable", checks });
  }

  @Get("metrics")
  async metrics(@Res() res: Response) {
    res.setHeader("Content-Type", registry.contentType);
    res.send(await registry.metrics());
  }
}