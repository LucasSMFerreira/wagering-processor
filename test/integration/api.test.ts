import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { setupDatabase } from "../support/db";
import { get, type Instance, post, startInstance, stopInstance } from "../support/instances";

let orm: MikroORM;
let app: Instance;
const queue = `api-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  orm = await setupDatabase();
  app = await startInstance(3201, { SQS_TRANSACTIONS_QUEUE: `${queue}.fifo`, SQS_EVENTS_QUEUE: `${queue}-events` });
});
afterAll(async () => {
  await stopInstance(app);
  await orm.close();
});

async function wallet(amount = "100.00") {
  const playerId = crypto.randomUUID();
  const res = await post(app.url, "/wallets", { playerId, initialBalance: { amount, currency: "BRL" } });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, playerId };
}

function bet(w: { id: string; playerId: string }, amount: string, extra: Record<string, unknown> = {}) {
  return {
    providerId: "provider-a",
    externalTransactionId: crypto.randomUUID(),
    playerId: w.playerId,
    walletId: w.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount, currency: "BRL" },
    ...extra,
  };
}

const submit = (body: ReturnType<typeof bet>, key = `${body.providerId}:${body.externalTransactionId}`) =>
  post(app.url, "/wagering/transactions", body, { "Idempotency-Key": key });

describe("HTTP API", () => {
  test("creates a wallet at version 1, and a duplicate is a conflict", async () => {
    const playerId = crypto.randomUUID();
    const body = { playerId, initialBalance: { amount: "1000.00", currency: "BRL" } };
    const first = await post(app.url, "/wallets", body);
    expect(first.body).toMatchObject({ playerId, balance: { amount: "1000.00", currency: "BRL" }, version: 1 });
    expect((await post(app.url, "/wallets", body)).status).toBe(409);
  });

  test("201 applied, 200 replay, 409 conflict, 422 rejection, 202 pending, 400 invalid", async () => {
    const w = await wallet("100.00");
    const b = bet(w, "25.00");
    expect(await submit(b)).toMatchObject({ status: 201, body: { status: "PROCESSED", balance: { amount: "75.00" }, idempotentReplay: false } });
    expect(await submit(b)).toMatchObject({ status: 200, body: { idempotentReplay: true } });
    expect((await submit({ ...b, money: { amount: "26.00", currency: "BRL" } })).status).toBe(409);
    expect(await submit(bet(w, "500.00"))).toMatchObject({ status: 422, body: { status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", action: "give-up" } });
    expect(await submit(bet(w, "1.00", { kind: "REFUND", referenceExternalTransactionId: "later" }))).toMatchObject({
      status: 202,
      body: { status: "PENDING_REFERENCE" },
    });
    expect((await submit(bet(w, "1.005"))).status).toBe(400);
    expect((await submit(bet(w, "1.00", { kind: "OPENING" }))).status).toBe(400);
    expect((await post(app.url, "/wagering/transactions", bet(w, "1.00"))).status).toBe(400); // no Idempotency-Key
  });

  test("queries by internal and by provider id", async () => {
    const w = await wallet();
    const b = bet(w, "10.00");
    const created = await submit(b);
    const byId = await get(app.url, `/wagering/transactions/${created.body.transactionId}`);
    expect(byId.body).toMatchObject({ kind: "BET", status: "PROCESSED", money: { amount: "10.00" } });
    const byExternal = await get(app.url, `/providers/provider-a/wagering/transactions/${b.externalTransactionId}`);
    expect(byExternal.body.transactionId).toBe(created.body.transactionId);
    expect((await get(app.url, `/wallets/${w.id}`)).body).toMatchObject({ balance: { amount: "90.00" }, version: 2 });
  });

  test("ledger pages with a stable cursor", async () => {
    const w = await wallet("100.00");
    for (let i = 0; i < 5; i++) await submit(bet(w, "1.00"));
    const first = await get(app.url, `/wallets/${w.id}/ledger?limit=4`);
    expect(first.body.entries).toHaveLength(4);
    const second = await get(app.url, `/wallets/${w.id}/ledger?limit=4&cursor=${first.body.nextCursor}`);
    expect(second.body.entries).toHaveLength(2);
    expect(second.body.nextCursor).toBeNull();
    expect((await get(app.url, `/wallets/${w.id}/ledger?cursor=garbage`)).status).toBe(400);
  });

  test("reconciliation reports a consistent wallet", async () => {
    const w = await wallet("50.00");
    await submit(bet(w, "20.00"));
    const res = await post(app.url, `/wallets/${w.id}/reconciliation`, {});
    expect(res.body).toMatchObject({ consistent: true, difference: { amount: "0.00" }, checkedEntries: 2 });
  });

  test("health and metrics are open", async () => {
    expect((await get(app.url, "/health/live")).status).toBe(200);
    expect((await get(app.url, "/health/ready")).body).toMatchObject({ checks: { postgres: "up", sqs: "up" } });
    const metrics = await (await fetch(`${app.url}/metrics`)).text();
    expect(metrics).toContain("wager_transactions_total");
    expect(metrics).toContain("wager_outbox_lag_seconds");
  });
});