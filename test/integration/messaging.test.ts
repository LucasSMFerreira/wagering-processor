import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { TransientError } from "../../src/app/errors";
import { OutboxPublisher } from "../../src/app/outbox.publisher";
import type { ProcessWagerTransaction } from "../../src/app/process-wager.use-case";
import { canonicalJson, sha256 } from "../../src/app/payload-hash";
import { type ConsumerOptions, WagerQueueConsumer } from "../../src/app/wager-queue.consumer";
import { assertLedgerInvariant, resetDatabase, setupDatabase, sql } from "../support/db";
import { command, createWallet, useCase } from "../support/factories";
import { drain, envelope, eventually, send, testQueues } from "../support/sqs";

let orm: MikroORM;
let q: Awaited<ReturnType<typeof testQueues>>;

beforeAll(async () => {
  orm = await setupDatabase();
});
afterAll(() => orm.close());
beforeEach(async () => {
  await resetDatabase(orm);
  q = await testQueues(1, 3);
});

const options = (): ConsumerOptions => ({
  consumerName: "wager-transactions",
  queueUrl: q.urls.main,
  dlqUrl: q.urls.dlq,
  maxReceiveCount: 3,
  waitTimeSeconds: 1,
  shutdownGraceMs: 5_000,
});

const debits = async (walletId: string) =>
  (await sql(orm, "select 1 from ledger_entries where wallet_id = ? and direction = 'DEBIT'", [walletId])).length;

describe("SQS consumer", () => {
  test("processes a message and acks it after the commit", async () => {
    const wallet = await createWallet(orm, "100.00");
    await send(q.sqs, q.urls.main, envelope(command(wallet, "BET", "25.00")), wallet.id);
    const consumer = new WagerQueueConsumer(q.sqs, useCase(orm), options());
    consumer.start();
    await eventually(async () => (await debits(wallet.id)) === 1);
    await consumer.stop();
    expect(await drain(q.sqs, q.urls.main, { waitSeconds: 2 })).toHaveLength(0);
    const inbox = await sql(orm, "select 1 from inbox_messages");
    expect(inbox).toHaveLength(1);
  });

  test("a redelivered message (same messageId) does not debit twice", async () => {
    const wallet = await createWallet(orm, "100.00");
    const message = envelope(command(wallet, "BET", "25.00"));
    await send(q.sqs, q.urls.main, message, wallet.id);
    await send(q.sqs, q.urls.main, message, wallet.id); // other SQS dedup id: SQS lets it through
    const consumer = new WagerQueueConsumer(q.sqs, useCase(orm), options());
    consumer.start();
    await eventually(async () => (await drain(q.sqs, q.urls.main, { remove: false, waitSeconds: 0 })).length === 0 && (await debits(wallet.id)) === 1);
    await Bun.sleep(1500);
    await consumer.stop();
    expect(await debits(wallet.id)).toBe(1);
  });

  test("worker dies after the commit and before the ack: redelivery is harmless", async () => {
    const wallet = await createWallet(orm, "100.00");
    const message = envelope(command(wallet, "BET", "25.00"));
    await send(q.sqs, q.urls.main, message, wallet.id);

    // Worker A: receives and commits, then "dies" without deleting the message.
    const received = await q.sqs.send(new ReceiveMessageCommand({ QueueUrl: q.urls.main, WaitTimeSeconds: 2 }));
    expect(received.Messages).toHaveLength(1);
    const { idempotencyKey, ...data } = message.data;
    await useCase(orm).execute(
      { ...data, idempotencyKey, money: command(wallet, "BET", "25.00").money } as never,
      { correlationId: message.messageId },
      { consumerName: "wager-transactions", messageId: message.messageId, payloadHash: sha256(canonicalJson(message.data)) },
    );
    expect(await debits(wallet.id)).toBe(1);

    // Worker B: gets it again after the visibility timeout, finds it in the inbox, acks.
    const consumer = new WagerQueueConsumer(q.sqs, useCase(orm), options());
    consumer.start();
    await Bun.sleep(3000);
    await consumer.stop();
    expect(await debits(wallet.id)).toBe(1);
    expect(await drain(q.sqs, q.urls.main, { waitSeconds: 2 })).toHaveLength(0);
    await assertLedgerInvariant(orm);
  });

  test("an unreadable message goes straight to the DLQ", async () => {
    await send(q.sqs, q.urls.main, "{not json", "g1");
    await send(q.sqs, q.urls.main, { messageId: "m", type: "WagerTransactionRequested", occurredAt: new Date().toISOString(), data: { idempotencyKey: "k", kind: "OPENING" } }, "g2");
    const consumer = new WagerQueueConsumer(q.sqs, useCase(orm), options());
    consumer.start();
    await eventually(async () => (await drain(q.sqs, q.urls.dlq, { remove: false, waitSeconds: 0 })).length === 2, 10_000);
    await consumer.stop();
    expect(await drain(q.sqs, q.urls.main, { waitSeconds: 1 })).toHaveLength(0);
  });

  test("transient errors are retried and end in the DLQ after maxReceiveCount", async () => {
    const wallet = await createWallet(orm, "100.00");
    await send(q.sqs, q.urls.main, envelope(command(wallet, "BET", "25.00")), wallet.id);
    let calls = 0;
    const failing = {
      execute: async () => {
        calls++;
        throw new TransientError("database unavailable");
      },
    } as unknown as ProcessWagerTransaction;
    const consumer = new WagerQueueConsumer(q.sqs, failing, options());
    consumer.start();
    await eventually(async () => (await drain(q.sqs, q.urls.dlq, { remove: false, waitSeconds: 0 })).length === 1, 30_000, 500);
    await consumer.stop();
    expect(calls).toBe(3);
    expect(await debits(wallet.id)).toBe(0);
  });

  test("SIGTERM waits for the message in hand", async () => {
    const wallet = await createWallet(orm, "100.00");
    await send(q.sqs, q.urls.main, envelope(command(wallet, "BET", "25.00")), wallet.id);
    const real = useCase(orm);
    let started = false;
    const slow = {
      execute: async (...args: Parameters<ProcessWagerTransaction["execute"]>) => {
        started = true;
        await Bun.sleep(800);
        return real.execute(...args);
      },
    } as unknown as ProcessWagerTransaction;
    const consumer = new WagerQueueConsumer(q.sqs, slow, options());
    consumer.start();
    await eventually(async () => started);
    await consumer.stop();
    expect(await debits(wallet.id)).toBe(1);
    expect(await drain(q.sqs, q.urls.main, { waitSeconds: 2 })).toHaveLength(0);
  });
});

describe("transactional outbox", () => {
  async function fillOutbox(n: number) {
    const wallet = await createWallet(orm, "1000.00");
    for (let i = 0; i < n; i++) await useCase(orm).execute(command(wallet, "BET", "1.00"), { correlationId: "c" });
    const [row] = await sql<{ n: number }>(orm, "select count(*)::int as n from outbox_messages");
    return row!.n;
  }

  test("publishes committed events once and marks them", async () => {
    const total = await fillOutbox(3);
    const publisher = new OutboxPublisher(orm, q.sqs, q.urls.events, { pollMs: 50, batchSize: 50, leaseMs: 30_000 });
    expect(await publisher.publishOnce()).toBe(total);
    expect(await publisher.publishOnce()).toBe(0);
    const received = await drain(q.sqs, q.urls.events);
    expect(received).toHaveLength(total);
    const body = JSON.parse(received[0]!.Body!);
    expect(body).toHaveProperty("eventId");
    expect(body).toHaveProperty("version", 1);
    expect(await sql(orm, "select 1 from outbox_messages where published_at is null")).toHaveLength(0);
  });

  test("two publishers on the same outbox do not send the same event twice", async () => {
    const total = await fillOutbox(20);
    const settings = { pollMs: 50, batchSize: 5, leaseMs: 30_000 };
    const a = new OutboxPublisher(orm, q.sqs, q.urls.events, settings);
    const b = new OutboxPublisher(orm, q.sqs, q.urls.events, settings);
    for (let i = 0; i < 10; i++) await Promise.all([a.publishOnce(), b.publishOnce()]);
    const received = await drain(q.sqs, q.urls.events);
    const ids = received.map((m) => JSON.parse(m.Body!).eventId);
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
  });

  test("process dies after the commit, before publishing: another instance publishes", async () => {
    const total = await fillOutbox(2);
    // Instance A claimed the batch (lease of 300 ms) and died before sending anything.
    await sql(orm, "update outbox_messages set locked_until = now() + interval '300 milliseconds'");
    const b = new OutboxPublisher(orm, q.sqs, q.urls.events, { pollMs: 50, batchSize: 50, leaseMs: 30_000 });
    expect(await b.publishOnce()).toBe(0); // lease still valid
    await Bun.sleep(400);
    expect(await b.publishOnce()).toBe(total);
  });

  test("a duplicated publication carries the same eventId, so consumers can drop it", async () => {
    await fillOutbox(1);
    const publisher = new OutboxPublisher(orm, q.sqs, q.urls.events, { pollMs: 50, batchSize: 50, leaseMs: 30_000 });
    await publisher.publishOnce();
    // Simulates "sent, then crashed before marking published": the row is pending again.
    await sql(orm, "update outbox_messages set published_at = null");
    await publisher.publishOnce();
    const received = await drain(q.sqs, q.urls.events);
    const ids = received.map((m) => JSON.parse(m.Body!).eventId as string);
    expect(ids.length).toBeGreaterThan(new Set(ids).size);
  });
});