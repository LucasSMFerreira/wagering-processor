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

async function balanceOf(walletId: string) {
  const [row] = await sql<{ balance: string; version: number }>(
    orm,
    "select balance_amount::text as balance, version from wallets where id = ?",
    [walletId],
  );
  return row!;
}

describe("process wager transaction", () => {
  test("BET debits, writes one ledger entry and two events, atomically", async () => {
    const wallet = await createWallet(orm, "1000.00");
    const result = await useCase(orm).execute(command(wallet, "BET", "25.00"), correlation);
    expect(result.kind).toBe("decided");
    if (result.kind !== "decided") return;
    expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(result.transaction.balanceAfter?.toString()).toBe("975.00");
    expect(await balanceOf(wallet.id)).toEqual({ balance: "975.00", version: 2 });

    const events = await sql<{ event_type: string }>(orm, "select event_type from outbox_messages order by seq");
    expect(events.map((e) => e.event_type)).toEqual([
      "WalletBalanceChanged", // opening
      "WalletBalanceChanged",
      "WagerTransactionProcessed",
    ]);
    await assertLedgerInvariant(orm);
  });

  test("replay returns the original result, with the balance of that moment", async () => {
    const wallet = await createWallet(orm, "100.00");
    const bet = command(wallet, "BET", "10.00");
    await useCase(orm).execute(bet, correlation);
    await useCase(orm).execute(command(wallet, "BET", "50.00"), correlation);
    const replay = await useCase(orm).execute(bet, correlation);
    expect(replay.kind === "decided" && replay.replay).toBe(true);
    expect(replay.kind === "decided" && replay.transaction.balanceAfter?.toString()).toBe("90.00");
    expect(await balanceOf(wallet.id)).toEqual({ balance: "40.00", version: 3 });
  });

  test("same key with a different payload is a conflict, not a replay", async () => {
    const wallet = await createWallet(orm, "100.00");
    const bet = command(wallet, "BET", "10.00");
    await useCase(orm).execute(bet, correlation);
    const result = await useCase(orm).execute({ ...bet, money: command(wallet, "BET", "11.00").money }, correlation);
    expect(result.kind).toBe("idempotency-conflict");
    expect((await balanceOf(wallet.id)).balance).toBe("90.00");
  });

  test("same external id under another key is a conflict too", async () => {
    const wallet = await createWallet(orm, "100.00");
    const bet = command(wallet, "BET", "10.00");
    await useCase(orm).execute(bet, correlation);
    const result = await useCase(orm).execute({ ...bet, idempotencyKey: "other-key" }, correlation);
    expect(result.kind).toBe("idempotency-conflict");
  });

  test("unknown wallet is reported and nothing is written", async () => {
    const wallet = { id: crypto.randomUUID(), playerId: "nobody" };
    const result = await useCase(orm).execute(command(wallet, "BET", "1.00"), correlation);
    expect(result.kind).toBe("wallet-not-found");
    expect(await sql(orm, "select 1 from wager_transactions")).toHaveLength(0);
  });

  test("rejection is persisted with its code and no ledger entry", async () => {
    const wallet = await createWallet(orm, "5.00");
    const result = await useCase(orm).execute(command(wallet, "BET", "6.00"), correlation);
    expect(result.kind === "decided" && result.transaction.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(await sql(orm, "select 1 from ledger_entries where wallet_id = ?", [wallet.id])).toHaveLength(1); // opening only
    expect(await balanceOf(wallet.id)).toEqual({ balance: "5.00", version: 1 });
  });

  test("LOSS is processed without ledger and without WalletBalanceChanged", async () => {
    const wallet = await createWallet(orm, "5.00");
    await useCase(orm).execute(command(wallet, "LOSS", "0.00"), correlation);
    const events = await sql<{ event_type: string }>(orm, "select event_type from outbox_messages order by seq");
    expect(events.map((e) => e.event_type)).toEqual(["WalletBalanceChanged", "WagerTransactionProcessed"]);
    expect((await balanceOf(wallet.id)).version).toBe(1);
  });

  test("REFUND of a processed BET, then a second reversal is refused", async () => {
    const wallet = await createWallet(orm, "100.00");
    const bet = command(wallet, "BET", "30.00");
    await useCase(orm).execute(bet, correlation);
    const ref = { referenceExternalTransactionId: bet.externalTransactionId };
    const refund = await useCase(orm).execute(command(wallet, "REFUND", "30.00", ref), correlation);
    expect(refund.kind === "decided" && refund.transaction.status).toBe(WagerTransactionStatus.Processed);
    const rollback = await useCase(orm).execute(command(wallet, "ROLLBACK", "30.00", ref), correlation);
    expect(rollback.kind === "decided" && rollback.transaction.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
    expect((await balanceOf(wallet.id)).balance).toBe("100.00");
    await assertLedgerInvariant(orm);
  });
});