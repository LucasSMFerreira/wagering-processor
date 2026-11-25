import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { z } from "zod";
import { config } from "../config";
import { log } from "../observability/logger";
import { metrics } from "../observability/metrics";
import { wagerTransactionSchema } from "./commands";
import { isTransient } from "./errors";
import { canonicalJson, sha256 } from "./payload-hash";
import type { ProcessWagerTransaction } from "./process-wager.use-case";

const envelopeSchema = z.object({
  messageId: z.string().min(1).max(200),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.string().datetime(),
  data: z.object({ idempotencyKey: z.string().min(1).max(400) }).passthrough(),
});

export interface ConsumerOptions {
  consumerName: string;
  queueUrl: string;
  dlqUrl: string;
  maxReceiveCount: number;
  waitTimeSeconds: number;
  /** How long stop() waits for in-flight messages before giving their visibility back. */
  shutdownGraceMs: number;
}

/**
 * Reads wager-transactions.fifo and calls the same use case as the HTTP API.
 *
 * - business outcome (processed, rejected, conflict, duplicate): ack
 * - transient error (database down, deadlock): no ack, visibility backoff, SQS redelivers
 * - permanent error (unreadable message): straight to the DLQ, then ack
 * - unexpected error: no ack; after maxReceiveCount receives the redrive policy moves it to the DLQ
 */
export class WagerQueueConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private abort = new AbortController();
  private readonly inFlight = new Map<string, Message>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly useCase: ProcessWagerTransaction,
    private readonly options: ConsumerOptions,
  ) {}

  start(): void {
    this.running = true;
    this.loop = this.poll();
  }

  /** SIGTERM: stop receiving, finish what is in hand, give back what does not finish in time. */
  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    const finished = this.loop ?? Promise.resolve();
    const timedOut = await Promise.race([
      finished.then(() => false),
      Bun.sleep(this.options.shutdownGraceMs).then(() => true),
    ]);
    if (timedOut) {
      await Promise.allSettled(
        [...this.inFlight.values()].map((m) =>
          this.sqs.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.options.queueUrl,
              ReceiptHandle: m.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          ),
        ),
      );
      log.warn("shutdown grace expired, visibility returned", { count: this.inFlight.size });
    }
  }

  private async poll(): Promise<void> {
    while (this.running) {
      let messages: Message[] = [];
      try {
        const out = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.options.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.options.waitTimeSeconds,
            MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
          }),
          { abortSignal: this.abort.signal },
        );
        messages = out.Messages ?? [];
      } catch (error) {
        if (!this.running) break;
        log.error("receive failed", { error: String(error) });
        await Bun.sleep(1000);
        continue;
      }
      await this.handleBatch(messages);
    }
  }

  /** Messages of the same group keep their order; different groups run in parallel. */
  async handleBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const group = m.Attributes?.MessageGroupId ?? m.MessageId!;
      groups.set(group, [...(groups.get(group) ?? []), m]);
    }
    await Promise.all(
      [...groups.values()].map(async (list) => {
        for (const m of list) await this.handle(m);
      }),
    );
  }

  private async handle(message: Message): Promise<void> {
    this.inFlight.set(message.MessageId!, message);
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    try {
      const parsed = this.parse(message.Body);
      if (!parsed.ok) {
        await this.toDlq(message, parsed.reason);
        await this.ack(message);
        return;
      }
      const { envelope, command } = parsed;
      const ctx = { correlationId: envelope.messageId, messageId: envelope.messageId, providerId: command.providerId };
      try {
        const result = await this.useCase.execute(
          command,
          { correlationId: envelope.messageId, causationId: envelope.messageId },
          {
            consumerName: this.options.consumerName,
            messageId: envelope.messageId,
            payloadHash: sha256(canonicalJson(envelope.data)),
          },
        );
        // Every result here is final for this message: the database already holds the outcome.
        await this.ack(message);
        log.info("message handled", { ...ctx, result: result.kind });
      } catch (error) {
        const transient = isTransient(error);
        metrics.retries.inc({ component: "sqs-consumer" });
        if (receiveCount >= this.options.maxReceiveCount) {
          metrics.dlq.inc({ reason: transient ? "transient-exhausted" : "unexpected" });
          log.error("giving up, SQS will move the message to the DLQ", { ...ctx, receiveCount, error: String(error) });
        } else {
          log.warn("processing failed, will be redelivered", { ...ctx, receiveCount, transient, error: String(error) });
        }
        await this.backoff(message, receiveCount);
      }
    } finally {
      this.inFlight.delete(message.MessageId!);
    }
  }

  private parse(body: string | undefined):
    | { ok: true; envelope: z.infer<typeof envelopeSchema>; command: Parameters<ProcessWagerTransaction["execute"]>[0] }
    | { ok: false; reason: string } {
    let json: unknown;
    try {
      json = JSON.parse(body ?? "");
    } catch {
      return { ok: false, reason: "invalid-json" };
    }
    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success) return { ok: false, reason: "invalid-envelope" };
    const { idempotencyKey, ...data } = envelope.data.data;
    const command = wagerTransactionSchema.safeParse(data);
    if (!command.success) return { ok: false, reason: "invalid-payload" };
    return { ok: true, envelope: envelope.data, command: { ...command.data, idempotencyKey } };
  }

  private ack(message: Message) {
    return this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  /** 2, 4, 8 ... seconds, at most 5 minutes. */
  private backoff(message: Message, receiveCount: number) {
    return this.sqs
      .send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: Math.min(2 ** receiveCount, 300),
        }),
      )
      .catch((error) => log.warn("visibility change failed", { error: String(error) }));
  }

  private async toDlq(message: Message, reason: string) {
    metrics.dlq.inc({ reason });
    log.error("permanent error, message sent to DLQ", { messageId: message.MessageId, reason });
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.options.dlqUrl,
        MessageBody: message.Body ?? "",
        MessageGroupId: message.Attributes?.MessageGroupId ?? "invalid",
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: { reason: { DataType: "String", StringValue: reason } },
      }),
    );
  }
}

export function consumerOptions(urls: { main: string; dlq: string }): ConsumerOptions {
  return {
    consumerName: "wager-transactions",
    queueUrl: urls.main,
    dlqUrl: urls.dlq,
    maxReceiveCount: config.sqs.maxReceiveCount,
    waitTimeSeconds: config.sqs.waitTimeSeconds,
    shutdownGraceMs: 10_000,
  };
}