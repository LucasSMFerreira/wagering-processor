import type { MikroORM } from "@mikro-orm/postgresql";
import { WalletBalanceChanged } from "../domain/events";
import type { WalletLedgerEntry } from "../domain/ledger-entry";
import { OutboxMessage } from "../domain/messages";
import { Money } from "../domain/money";
import { WagerTransaction } from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { LedgerEntryRecord, WalletRecord } from "../infra/db/records";
import { toLedgerEntry, WageringRepository } from "../infra/db/wagering.repository";
import { log } from "../observability/logger";
import { metrics } from "../observability/metrics";
import type { CreateWalletInput } from "./commands";
import { isUniqueViolation } from "./errors";
import { canonicalJson, sha256 } from "./payload-hash";
import type { Correlation } from "./record-outcome";

export type CreateWalletResult = { kind: "created"; wallet: Wallet } | { kind: "already-exists" };

export class CreateWallet {
  constructor(private readonly orm: MikroORM) {}

  /** Wallet, OPENING transaction, its CREDIT entry and the event: one SQL transaction. */
  async execute(input: CreateWalletInput, correlation: Correlation): Promise<CreateWalletResult> {
    const now = new Date();
    const walletId = Bun.randomUUIDv7();
    const openingTxId = Bun.randomUUIDv7();
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: input.playerId,
      initialBalance: input.initialBalance,
      openingTransactionId: openingTxId,
      openingEntryId: Bun.randomUUIDv7(),
      at: now,
    });

    try {
      await this.orm.em.fork().transactional(async (em) => {
        const repo = new WageringRepository(em);
        repo.insertWallet(wallet);
        if (openingEntry) {
          repo.insertTransaction(this.openingTransaction(wallet, openingEntry, now));
          repo.insertLedgerEntry(openingEntry);
          repo.insertOutbox(
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, openingEntry, {
                ...correlation,
                eventId: Bun.randomUUIDv7(),
                occurredAt: now,
              }),
            ),
          );
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { kind: "already-exists" };
      throw error;
    }
    log.info("wallet created", { correlationId: correlation.correlationId, walletId });
    return { kind: "created", wallet };
  }

  private openingTransaction(wallet: Wallet, entry: WalletLedgerEntry, now: Date): WagerTransaction {
    const key = `internal:opening:${wallet.id}`;
    const tx = WagerTransaction.opening({
      id: entry.transactionId,
      providerId: "internal",
      externalTransactionId: `opening:${wallet.id}`,
      idempotencyKey: key,
      payloadHash: sha256(canonicalJson({ walletId: wallet.id, money: entry.money.toJSON() })),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: "opening",
      gameId: "opening",
      money: entry.money,
      createdAt: now,
    });
    tx.markProcessed(undefined, now, entry.balanceAfter);
    return tx;
  }
}

export class WalletQueries {
  constructor(private readonly orm: MikroORM) {}

  getWallet(walletId: string) {
    return new WageringRepository(this.orm.em.fork()).findWallet(walletId);
  }

  getTransaction(transactionId: string) {
    return new WageringRepository(this.orm.em.fork()).findTransaction(transactionId);
  }

  getTransactionByExternalId(providerId: string, externalTransactionId: string) {
    return new WageringRepository(this.orm.em.fork()).findByExternalId(providerId, externalTransactionId);
  }

  /** Keyset pagination on the ledger's sequence: stable while new entries arrive. */
  async ledger(walletId: string, cursor: string | undefined, limit: number) {
    const afterSeq = cursor ? decodeCursor(cursor) : undefined;
    const rows = await new WageringRepository(this.orm.em.fork()).ledgerPage(walletId, afterSeq, limit);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map(toLedgerEntry),
      nextCursor: rows.length > limit && last?.seq != null ? encodeCursor(String(last.seq)) : null,
    };
  }
}

export function encodeCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ s: seq })).toString("base64url");
}

export function decodeCursor(cursor: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { s?: unknown };
    if (typeof parsed.s === "string" && /^\d+$/.test(parsed.s)) return parsed.s;
  } catch {}
  throw new InvalidCursorError();
}

export class InvalidCursorError extends Error {}

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

export class ReconcileWallet {
  constructor(private readonly orm: MikroORM) {}

  /** Recomputes the balance from the ledger. Never fixes anything: it reports. */
  async execute(walletId: string, correlation: Correlation): Promise<ReconciliationReport | undefined> {
    const em = this.orm.em.fork();
    return em.transactional(async (tem) => {
      // REPEATABLE READ snapshot: wallet and ledger are read at the same instant.
      await tem.execute("set transaction isolation level repeatable read");
      const wallet = await tem.findOne(WalletRecord, { id: walletId });
      if (!wallet) return undefined;
      const [row] = await tem.execute<{ calculated: string; entries: string }[]>(
        `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(20,2)::text as calculated,
                count(*)::text as entries
           from ${tem.getMetadata(LedgerEntryRecord).tableName} where wallet_id = ?`,
        [walletId],
      );
      const stored = Money.parse({ amount: wallet.balanceAmount, currency: wallet.currency });
      const calculated = Money.parse({ amount: row?.calculated ?? "0", currency: wallet.currency });
      const difference = stored.subtract(calculated);
      const report = {
        walletId,
        storedBalance: stored,
        calculatedBalance: calculated,
        difference,
        consistent: difference.isZero(),
        checkedEntries: Number(row?.entries ?? 0),
      };
      if (!report.consistent) {
        metrics.reconciliationMismatches.inc();
        log.error("reconciliation mismatch", {
          correlationId: correlation.correlationId,
          walletId,
          checkedEntries: report.checkedEntries,
        });
      }
      return report;
    });
  }
}