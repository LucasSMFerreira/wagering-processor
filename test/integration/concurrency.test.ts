import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { WagerTransactionStatus } from "../../src/domain/wager-transaction";
import { assertLedgerInvariant, resetDatabase, setupDatabase, sql } from "../support/db";
import { command, correlation, createWallet, useCase } from "../support/factories";

let orm: MikroORM;

beforeAll(async () => {
  orm = await setupDatabase();
});
afterAll(() => orm.close());
beforeEach(() => resetDatabase(orm));

const debits = (walletId: string) =>
  sql(orm, "select 1 from ledger_entries where wallet_id = ? and direction = 'DEBIT'", [walletId]);

describe("concurrency (real parallel SQL transactions)", () => {
  test("the same BET sent 50 times in parallel debits once", async () => {
    const wallet = await createWallet(orm, "100.00");
    const bet = command(wallet, "BET", "10.00");
    const results = await Promise.all(Array.from({ length: 50 }, () => useCase(orm).execute(bet, correlation)));

    const fresh = results.filter((r) => r.kind === "decided" && !r.replay);
    const replays = results.filter((r) => r.kind === "decided" && r.replay);
    expect(fresh).toHaveLength(1);
    expect(replays).toHaveLength(49);
    expect(await debits(wallet.id)).toHaveLength(1);
    await assertLedgerInvariant(orm);
  });

  test("100.00 and two BETs of 80.00 at the same time: one wins, one is rejected", async () => {
    const wallet = await createWallet(orm, "100.00");
    const bets = [command(wallet, "BET", "80.00"), command(wallet, "BET", "80.00")];
    const results = await Promise.all(bets.map((bet) => useCase(orm).execute(bet, correlation)));
    const statuses = results.map((r) => (r.kind === "decided" ? r.transaction.status : r.kind)).sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);
    const rejected = results.find((r) => r.kind === "decided" && r.transaction.status === WagerTransactionStatus.Rejected);
    expect(rejected?.kind === "decided" && rejected.transaction.failureCode).toBe("INSUFFICIENT_FUNDS");

    const [row] = await sql<{ balance: string }>(orm, "select balance_amount::text as balance from wallets where id = ?", [wallet.id]);
    expect(row?.balance).toBe("20.00");
    expect(await debits(wallet.id)).toHaveLength(1);

    // retrying both, in parallel again, changes nothing
    const retries = await Promise.all(bets.map((bet) => useCase(orm).execute(bet, correlation)));
    expect(retries.every((r) => r.kind === "decided" && r.replay)).toBe(true);
    expect(await debits(wallet.id)).toHaveLength(1);
    await assertLedgerInvariant(orm);
  });

  test("a hot wallet under 40 mixed operations never goes negative", async () => {
    const wallet = await createWallet(orm, "100.00");
    const ops = Array.from({ length: 40 }, (_, i) =>
      i % 4 === 0 ? command(wallet, "WIN", "5.00") : command(wallet, "BET", "7.00"),
    );
    await Promise.all(ops.map((op) => useCase(orm).execute(op, correlation)));
    const [row] = await sql<{ balance: string }>(orm, "select balance_amount::text as balance from wallets where id = ?", [wallet.id]);
    expect(Number.parseFloat(row!.balance)).toBeGreaterThanOrEqual(0);
    await assertLedgerInvariant(orm);
  });

  test("different wallets are processed in parallel, not one after the other", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(orm, "50.00")));
    // Hold a lock on wallet 0 for a while; the other wallets must not wait for it.
    const holder = orm.em.fork().transactional(async (em) => {
      await em.execute("select id from wallets where id = ? for update", [wallets[0]!.id]);
      await Bun.sleep(1500);
    });
    await Bun.sleep(100);
    const started = performance.now();
    await Promise.all(wallets.slice(1).map((w) => useCase(orm).execute(command(w, "BET", "10.00"), correlation)));
    const elapsed = performance.now() - started;
    await holder;
    expect(elapsed).toBeLessThan(1000);
    await assertLedgerInvariant(orm);
  });
});