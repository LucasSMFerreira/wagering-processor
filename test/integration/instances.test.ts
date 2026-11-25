import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../../src/domain/money";
import { assertLedgerInvariant, setupDatabase, sql } from "../support/db";
import { command } from "../support/factories";
import { type Instance, post, startInstance, stopInstance } from "../support/instances";
import { envelope, eventually, send, testQueues } from "../support/sqs";

let orm: MikroORM;
let q: Awaited<ReturnType<typeof testQueues>>;
let instances: Instance[] = [];
let env: Record<string, string>;

beforeAll(async () => {
  orm = await setupDatabase();
  q = await testQueues(2, 5);
  env = {
    SQS_TRANSACTIONS_QUEUE: q.urls.main.split("/").pop()!,
    SQS_EVENTS_QUEUE: q.urls.events.split("/").pop()!,
    SQS_VISIBILITY_SECONDS: "2",
  };
  instances = await Promise.all([3301, 3302, 3303].map((port) => startInstance(port, env)));
});
afterAll(async () => {
  await Promise.all(instances.map((i) => stopInstance(i)));
  await orm.close();
});

async function wallet(amount: string) {
  const playerId = crypto.randomUUID();
  const res = await post(instances[0]!.url, "/wallets", { playerId, initialBalance: { amount, currency: "BRL" } });
  return { id: res.body.id as string, playerId };
}

function httpBody(c: ReturnType<typeof command>) {
  const { idempotencyKey, money, ...rest } = c;
  return { body: { ...rest, money: money.toJSON() }, key: idempotencyKey };
}

const balance = async (walletId: string) =>
  (await sql<{ b: string }>(orm, "select balance_amount::text as b from wallets where id = ?", [walletId]))[0]!.b;

describe("three instances at the same time", () => {
  test("the same BET sent 50 times, spread over 3 instances, debits once", async () => {
    const w = await wallet("100.00");
    const { body, key } = httpBody(command(w, "BET", "10.00"));
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => post(instances[i % 3]!.url, "/wagering/transactions", body, { "Idempotency-Key": key })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(49);
    expect(await balance(w.id)).toBe("90.00");
  });

  test("100.00 and two BETs of 80.00 on two different instances", async () => {
    const w = await wallet("100.00");
    const a = httpBody(command(w, "BET", "80.00"));
    const b = httpBody(command(w, "BET", "80.00"));
    const results = await Promise.all([
      post(instances[0]!.url, "/wagering/transactions", a.body, { "Idempotency-Key": a.key }),
      post(instances[1]!.url, "/wagering/transactions", b.body, { "Idempotency-Key": b.key }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(await balance(w.id)).toBe("20.00");
  });

  test("SQS messages for 5 wallets consumed by 3 instances, with duplicates", async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => wallet("100.00")));
    for (const w of wallets) {
      for (let i = 0; i < 6; i++) {
        const message = envelope(command(w, i % 2 === 0 ? "BET" : "WIN", "5.00"));
        await send(q.sqs, q.urls.main, message, w.id);
        if (i === 0) await send(q.sqs, q.urls.main, message, w.id); // redelivery
      }
    }
    const ids = wallets.map((w) => w.id);
    await eventually(async () => {
      const [row] = await sql<{ n: number }>(
        orm,
        `select count(*)::int as n from ledger_entries l join wager_transactions t on t.id = l.transaction_id
          where t.kind <> 'OPENING' and l.wallet_id in (${ids.map(() => "?").join(",")})`,
        ids,
      );
      return row!.n === 30;
    }, 30_000, 250);
    for (const w of wallets) expect(await balance(w.id)).toBe("100.00");
    await assertLedgerInvariant(orm);
  });

  test("an instance killed with SIGKILL mid-traffic, then restarted: the books still close", async () => {
    const w = await wallet("1000.00");
    const bets = Array.from({ length: 60 }, () => httpBody(command(w, "BET", "1.00")));
    const traffic = bets.map((b, i) =>
      post(instances[i % 3]!.url, "/wagering/transactions", b.body, { "Idempotency-Key": b.key }).catch(() => null),
    );
    await Bun.sleep(30);
    await stopInstance(instances[2]!, "SIGKILL");
    await Promise.all(traffic);

    instances[2] = await startInstance(3303, env);
    // The provider resends everything (at-least-once): nothing is debited twice, nothing is lost.
    const resent = await Promise.all(
      bets.map((b, i) => post(instances[i % 3]!.url, "/wagering/transactions", b.body, { "Idempotency-Key": b.key })),
    );
    expect(resent.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(await balance(w.id)).toBe(Money.from({ amount: "940.00", currency: "BRL" }).toString());

    const report = await post(instances[2]!.url, `/wallets/${w.id}/reconciliation`, {});
    expect(report.body.consistent).toBe(true);
    await eventually(async () => (await sql(orm, "select 1 from outbox_messages where published_at is null")).length === 0, 15_000);
    await assertLedgerInvariant(orm);
  });
});