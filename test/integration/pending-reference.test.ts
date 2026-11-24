import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { PendingReferenceWorker } from "../../src/app/pending-reference.worker";
import { WagerTransactionStatus } from "../../src/domain/wager-transaction";
import { assertLedgerInvariant, resetDatabase, setupDatabase, sql } from "../support/db";
import { command, correlation, createWallet, useCase } from "../support/factories";

let orm: MikroORM;
const settings = { maxAttempts: 3, baseDelayMs: 1000, pollMs: 50 };
const future = (ms: number) => new Date(Date.now() + ms);

beforeAll(async () => {
  orm = await setupDatabase();
});
afterAll(() => orm.close());
beforeEach(() => resetDatabase(orm));

async function statusOf(externalId: string) {
  const [row] = await sql<{ status: string; failure_code: string | null; reference_attempts: number }>(
    orm,
    "select status, failure_code, reference_attempts from wager_transactions where external_transaction_id = ?",
    [externalId],
  );
  return row!;
}

describe("references out of order", () => {
  test("ROLLBACK before its BET waits, then is applied by the worker", async () => {
    const wallet = await createWallet(orm, "100.00");
    const bet = command(wallet, "BET", "40.00");
    const rollback = command(wallet, "ROLLBACK", "40.00", { referenceExternalTransactionId: bet.externalTransactionId });

    const early = await useCase(orm).execute(rollback, correlation);
    expect(early.kind === "decided" && early.transaction.status).toBe(WagerTransactionStatus.PendingReference);

    await useCase(orm).execute(bet, correlation);
    const worker = new PendingReferenceWorker(orm, settings);
    expect(await worker.runOnce(future(5_000))).toBe(1);

    expect((await statusOf(rollback.externalTransactionId)).status).toBe("PROCESSED");
    const [w] = await sql<{ balance: string }>(orm, "select balance_amount::text as balance from wallets where id = ?", [wallet.id]);
    expect(w?.balance).toBe("100.00");
    await assertLedgerInvariant(orm);
  });

  test("replay of a pending transaction stays pending, then shows the final result", async () => {
    const wallet = await createWallet(orm, "100.00");
    const bet = command(wallet, "BET", "40.00");
    const refund = command(wallet, "REFUND", "40.00", { referenceExternalTransactionId: bet.externalTransactionId });
    await useCase(orm).execute(refund, correlation);
    const again = await useCase(orm).execute(refund, correlation);
    expect(again.kind === "decided" && again.replay && again.transaction.status).toBe(WagerTransactionStatus.PendingReference);

    await useCase(orm).execute(bet, correlation);
    await new PendingReferenceWorker(orm, settings).runOnce(future(5_000));
    const final = await useCase(orm).execute(refund, correlation);
    expect(final.kind === "decided" && final.transaction.status).toBe(WagerTransactionStatus.Processed);
  });

  test("gives up after the attempt limit with REFERENCE_NOT_FOUND and an event", async () => {
    const wallet = await createWallet(orm, "100.00");
    const refund = command(wallet, "REFUND", "40.00", { referenceExternalTransactionId: "never-arrives" });
    await useCase(orm).execute(refund, correlation);
    const worker = new PendingReferenceWorker(orm, settings);

    await worker.runOnce(future(10_000)); // attempt 1
    expect(await statusOf(refund.externalTransactionId)).toMatchObject({ status: "PENDING_REFERENCE", reference_attempts: 1 });
    await worker.runOnce(future(60_000)); // attempt 2
    await worker.runOnce(future(120_000)); // attempt 3 = limit
    expect(await statusOf(refund.externalTransactionId)).toMatchObject({
      status: "REJECTED",
      failure_code: "REFERENCE_NOT_FOUND",
    });
    const events = await sql<{ event_type: string }>(orm, "select event_type from outbox_messages order by seq");
    expect(events.map((e) => e.event_type)).toContain("WagerTransactionPendingReference");
    expect(events.at(-1)?.event_type).toBe("WagerTransactionRejected");
  });

  test("does not touch transactions that are not due yet", async () => {
    const wallet = await createWallet(orm, "100.00");
    await useCase(orm).execute(command(wallet, "REFUND", "1.00", { referenceExternalTransactionId: "x" }), correlation);
    expect(await new PendingReferenceWorker(orm, settings).runOnce(new Date())).toBe(0);
  });

  test("two workers at the same time process each pending transaction once", async () => {
    const wallet = await createWallet(orm, "100.00");
    const bets = Array.from({ length: 5 }, () => command(wallet, "BET", "10.00"));
    for (const bet of bets) {
      await useCase(orm).execute(command(wallet, "REFUND", "10.00", { referenceExternalTransactionId: bet.externalTransactionId }), correlation);
    }
    for (const bet of bets) await useCase(orm).execute(bet, correlation);
    const at = future(5_000);
    await Promise.all([
      new PendingReferenceWorker(orm, settings).runOnce(at),
      new PendingReferenceWorker(orm, settings).runOnce(at),
    ]);
    const credits = await sql(orm, "select 1 from ledger_entries where wallet_id = ? and direction = 'CREDIT'", [wallet.id]);
    expect(credits).toHaveLength(1 + 5); // opening + 5 refunds
    await assertLedgerInvariant(orm);
  });
});