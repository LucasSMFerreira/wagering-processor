import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { resetDatabase, setupDatabase, sql } from "../support/db";
import { command, correlation, createWallet, useCase } from "../support/factories";

let orm: MikroORM;

beforeAll(async () => {
  orm = await setupDatabase();
});
afterAll(() => orm.close());
beforeEach(() => resetDatabase(orm));

/** The database refuses these even if the TypeScript code had a bug. */
describe("schema guarantees", () => {
  test("balance cannot go negative", async () => {
    const wallet = await createWallet(orm, "10.00");
    await expect(sql(orm, "update wallets set balance_amount = -1 where id = ?", [wallet.id])).rejects.toThrow(/check/i);
  });

  test("wallet balance must match the ledger at commit", async () => {
    const wallet = await createWallet(orm, "10.00");
    await expect(sql(orm, "update wallets set balance_amount = 50 where id = ?", [wallet.id])).rejects.toThrow(
      /does not match ledger/,
    );
  });

  test("one wallet per player and currency", async () => {
    const wallet = await createWallet(orm, "10.00");
    await expect(
      sql(orm, "insert into wallets values (gen_random_uuid(), ?, 'BRL', 0, 1, now(), now())", [wallet.playerId]),
    ).rejects.toThrow(/wallets_player_currency_unique/);
  });

  test("ledger entries cannot be updated or deleted", async () => {
    await createWallet(orm, "10.00");
    await expect(sql(orm, "update ledger_entries set amount = 1")).rejects.toThrow(/immutable/);
    await expect(sql(orm, "delete from ledger_entries")).rejects.toThrow(/immutable/);
  });

  test("a ledger entry must continue the previous balance", async () => {
    const wallet = await createWallet(orm, "10.00");
    const [tx] = await sql<{ id: string }>(orm, "select id from wager_transactions where wallet_id = ?", [wallet.id]);
    await expect(
      sql(
        orm,
        `insert into ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         values (gen_random_uuid(), ?, ?, 'CREDIT', 5, 'BRL', 999, 1004, now())`,
        [wallet.id, tx!.id],
      ),
    ).rejects.toThrow(/chain broken/);
  });

  test("a ledger entry must balance", async () => {
    const wallet = await createWallet(orm, "10.00");
    const [tx] = await sql<{ id: string }>(orm, "select id from wager_transactions where wallet_id = ?", [wallet.id]);
    await expect(
      sql(
        orm,
        `insert into ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         values (gen_random_uuid(), ?, ?, 'DEBIT', 5, 'BRL', 10, 10, now())`,
        [wallet.id, tx!.id],
      ),
    ).rejects.toThrow(/ledger_entry_balances/);
  });

  test("a terminal transaction cannot change", async () => {
    await createWallet(orm, "10.00");
    await expect(sql(orm, "update wager_transactions set status = 'REJECTED', failure_code = 'X'")).rejects.toThrow(
      /cannot change/,
    );
  });

  test("idempotency key and external id are unique", async () => {
    const wallet = await createWallet(orm, "10.00");
    await useCase(orm).execute(command(wallet, "BET", "1.00", { externalTransactionId: "dup" }), correlation);
    await expect(
      sql(orm, "insert into wager_transactions select * from wager_transactions where external_transaction_id = 'dup'"),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  test("a reference is reverted at most once", async () => {
    const wallet = await createWallet(orm, "10.00");
    const bet = command(wallet, "BET", "1.00");
    await useCase(orm).execute(bet, correlation);
    await useCase(orm).execute(
      command(wallet, "REFUND", "1.00", { referenceExternalTransactionId: bet.externalTransactionId }),
      correlation,
    );
    await expect(
      sql(
        orm,
        `insert into wager_transactions
           select gen_random_uuid(), provider_id, external_transaction_id || '-b', idempotency_key || '-b', payload_hash,
                  wallet_id, player_id, round_id, game_id, 'ROLLBACK', amount, currency, reference_external_transaction_id,
                  reference_transaction_id, status, failure_code, balance_after_amount, processed_at, 0, null, now()
             from wager_transactions where kind = 'REFUND'`,
      ),
    ).rejects.toThrow(/wager_tx_one_reversal_per_reference/);
  });

  test("REFUND without reference is refused by the schema", async () => {
    const wallet = await createWallet(orm, "10.00");
    await expect(
      sql(
        orm,
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
           player_id, round_id, game_id, kind, amount, currency, status, created_at)
         values (gen_random_uuid(), 'p', 'x', 'k', repeat('0', 64), ?, 'p1', 'r', 'g', 'REFUND', 1, 'BRL', 'PENDING', now())`,
        [wallet.id],
      ),
    ).rejects.toThrow(/wager_tx_reversal_needs_reference/);
  });
});