import { SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { config } from "../config";
import { OutboxMessage } from "../domain/messages";
import { log } from "../observability/logger";
import { metrics } from "../observability/metrics";

interface ClaimedRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
}

/**
 * Publishes committed events. Many publishers can run at once:
 * a batch is claimed with FOR UPDATE SKIP LOCKED and a lease (locked_until),
 * so each message has one owner at a time. If the owner dies after sending and before
 * marking it, the lease expires and the message is sent again: at-least-once,
 * consumers deduplicate by eventId.
 */
export class OutboxPublisher {
  private timer: Timer | undefined;
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly eventsQueueUrl: string,
    private readonly settings = config.outbox,
  ) {}

  start(): void {
    const tick = () => {
      let full = false;
      this.running = this.publishOnce()
        .then((published) => {
          full = published >= this.settings.batchSize; // backlog: go again right away
        })
        .catch((error) => log.error("outbox publisher failed", { error: String(error) }))
        .finally(() => {
          if (this.timer) this.timer = setTimeout(tick, full ? 0 : this.settings.pollMs);
        });
    };
    this.timer = setTimeout(tick, this.settings.pollMs);
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  async publishOnce(): Promise<number> {
    const conn = this.orm.em.getConnection();
    const claimed = (await conn.execute(
      `update outbox_messages set locked_until = now() + (? * interval '1 millisecond')
        where id in (
          select id from outbox_messages
           where published_at is null and next_attempt_at <= now()
             and (locked_until is null or locked_until < now())
           order by seq limit ? for update skip locked)
        returning id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at`,
      [this.settings.leaseMs, this.settings.batchSize],
    )) as ClaimedRow[];

    const messages = claimed.map((row) =>
      OutboxMessage.rehydrate({
        id: row.id,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: row.payload,
        occurredAt: row.occurred_at,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
      }),
    );

    let published = 0;
    // SQS takes at most 10 messages per batch call.
    for (let i = 0; i < messages.length; i += 10) {
      const chunk = messages.slice(i, i + 10);
      let failedIds = new Set(chunk.map((m) => m.id));
      try {
        const out = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: this.eventsQueueUrl,
            Entries: chunk.map((m) => ({
              Id: m.id,
              MessageBody: JSON.stringify(m.payload),
              MessageAttributes: {
                eventType: { DataType: "String", StringValue: m.eventType },
                eventId: { DataType: "String", StringValue: m.id },
              },
            })),
          }),
        );
        failedIds = new Set((out.Failed ?? []).map((f) => f.Id!));
      } catch (error) {
        log.warn("outbox batch failed", { error: String(error) });
      }

      const now = new Date();
      for (const message of chunk) {
        if (!failedIds.has(message.id)) {
          message.markPublished(now);
          published++;
          continue;
        }
        message.scheduleRetry(now);
        metrics.retries.inc({ component: "outbox" });
        await conn.execute(
          "update outbox_messages set attempts = ?, next_attempt_at = ?, locked_until = null where id = ?",
          [message.attempts, message.nextAttemptAt, message.id],
        );
      }
      const sent = chunk.filter((m) => !m.isPending()).map((m) => m.id);
      if (sent.length > 0) {
        await conn.execute(
          `update outbox_messages set published_at = ?, locked_until = null where id in (${sent.map(() => "?").join(",")})`,
          [now, ...sent],
        );
      }
    }
    await this.refreshLag();
    return published;
  }

  private async refreshLag(): Promise<void> {
    const [row] = (await this.orm.em
      .getConnection()
      .execute(
        `select count(*)::int as pending,
                coalesce(extract(epoch from now() - min(occurred_at)), 0)::float as lag
           from outbox_messages where published_at is null`,
      )) as { pending: number; lag: number }[];
    metrics.outboxPending.set(row?.pending ?? 0);
    metrics.outboxLag.set(row?.lag ?? 0);
  }
}