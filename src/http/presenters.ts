import type { ProcessResult } from "../app/process-wager.use-case";
import type { ReconciliationReport } from "../app/wallets.use-cases";
import { FailureCode, failureAction } from "../domain/failure-code";
import type { WalletLedgerEntry } from "../domain/ledger-entry";
import { type WagerTransaction, WagerTransactionStatus } from "../domain/wager-transaction";
import type { Wallet } from "../domain/wallet";

export const walletView = (w: Wallet) => ({
  id: w.id,
  playerId: w.playerId,
  balance: w.balance.toJSON(),
  version: w.version,
});

export const transactionView = (tx: WagerTransaction) => ({
  transactionId: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId,
  gameId: tx.gameId,
  kind: tx.kind,
  money: tx.money.toJSON(),
  referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
  referenceTransactionId: tx.referenceTransactionId ?? null,
  status: tx.status,
  failureCode: tx.failureCode ?? null,
  balanceAfter: tx.balanceAfter?.toJSON() ?? null,
  createdAt: tx.createdAt.toISOString(),
  processedAt: tx.processedAt?.toISOString() ?? null,
});

export const ledgerEntryView = (e: WalletLedgerEntry) => ({
  id: e.id,
  transactionId: e.transactionId,
  direction: e.direction,
  money: e.money.toJSON(),
  balanceBefore: e.balanceBefore.toJSON(),
  balanceAfter: e.balanceAfter.toJSON(),
  createdAt: e.createdAt.toISOString(),
});

export const reconciliationView = (r: ReconciliationReport) => ({
  walletId: r.walletId,
  storedBalance: r.storedBalance.toJSON(),
  calculatedBalance: r.calculatedBalance.toJSON(),
  difference: r.difference.toJSON(),
  consistent: r.consistent,
  checkedEntries: r.checkedEntries,
});

export interface HttpAnswer {
  status: number;
  body: Record<string, unknown>;
}

/**
 * One status per situation, the same in every endpoint:
 * 201 applied now · 200 replay of an applied one · 202 accepted, waiting for its reference
 * 400 invalid payload · 409 idempotency conflict · 422 business rejection · 503 transient failure
 */
export function answerFor(result: ProcessResult): HttpAnswer {
  switch (result.kind) {
    case "decided": {
      const tx = result.transaction;
      const body = {
        transactionId: tx.id,
        status: tx.status,
        balance: tx.balanceAfter?.toJSON() ?? null,
        idempotentReplay: result.replay,
        failureCode: tx.failureCode ?? null,
        action: tx.failureCode ? failureAction[tx.failureCode] : null,
      };
      switch (tx.status) {
        case WagerTransactionStatus.Processed:
          return { status: result.replay ? 200 : 201, body };
        case WagerTransactionStatus.Rejected:
          return { status: 422, body };
        case WagerTransactionStatus.PendingReference:
        case WagerTransactionStatus.Pending:
          return { status: 202, body };
        case WagerTransactionStatus.Failed:
          return { status: 500, body };
      }
      break;
    }
    case "idempotency-conflict":
      return {
        status: 409,
        body: {
          error: "IDEMPOTENCY_CONFLICT",
          message: "this key or external id was already used with a different payload",
          transactionId: result.transactionId,
          action: "fix-payload",
        },
      };
    case "wallet-not-found":
      return {
        status: 422,
        body: { error: FailureCode.WalletNotFound, failureCode: FailureCode.WalletNotFound, action: "fix-payload" },
      };
    case "duplicate-message":
      return { status: 200, body: { duplicate: true } };
  }
  throw new Error("unreachable");
}