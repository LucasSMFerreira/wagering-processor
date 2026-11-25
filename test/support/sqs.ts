import { DeleteMessageCommand, type Message, ReceiveMessageCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { ProcessWagerCommand } from "../../src/app/commands";
import { createSqsClient, ensureQueues } from "../../src/infra/sqs/sqs";

export async function testQueues(visibilityTimeoutSeconds = 1, maxReceiveCount = 3) {
  const sqs = createSqsClient();
  const id = crypto.randomUUID().slice(0, 8);
  const urls = await ensureQueues(sqs, {
    main: `test-${id}.fifo`,
    events: `test-events-${id}`,
    maxReceiveCount,
    visibilityTimeoutSeconds,
  });
  return { sqs, urls };
}

export function envelope(command: ProcessWagerCommand, messageId = crypto.randomUUID()) {
  const { idempotencyKey, money, ...rest } = command;
  return {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: { ...rest, idempotencyKey, money: money.toJSON() },
  };
}

export function send(sqs: SQSClient, queueUrl: string, body: unknown, group: string, dedup = crypto.randomUUID()) {
  return sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === "string" ? body : JSON.stringify(body),
      MessageGroupId: group,
      MessageDeduplicationId: dedup,
    }),
  );
}

/** Reads everything currently visible in a queue (and deletes it when asked). */
export async function drain(sqs: SQSClient, queueUrl: string, { remove = true, waitSeconds = 1 } = {}): Promise<Message[]> {
  const all: Message[] = [];
  for (;;) {
    const out = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: waitSeconds, MessageAttributeNames: ["All"] }),
    );
    const messages = out.Messages ?? [];
    if (messages.length === 0) return all;
    all.push(...messages);
    if (remove) {
      for (const m of messages) await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
    }
  }
}

export async function eventually(check: () => Promise<boolean>, timeoutMs = 15_000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(stepMs);
  }
  throw new Error("condition not met in time");
}