import {
  type EventContext,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events";
import { OutboxMessage } from "../domain/messages";
import type { SettleOutcome } from "../domain/settlement";
import { type WagerTransaction, WagerTransactionStatus } from "../domain/wager-transaction";
import type { LockedWallet, WageringRepository } from "../infra/db/wagering.repository";

export interface Correlation {
  correlationId: string;
  causationId?: string | undefined;
}

/**
 * Writes what settle() decided: wallet, ledger entry and integration events.
 * Runs inside the caller's SQL transaction, so all of it commits together or not at all.
 */
export function recordOutcome(
  repo: WageringRepository,
  locked: LockedWallet,
  tx: WagerTransaction,
  outcome: SettleOutcome,
  correlation: Correlation,
  now: Date,
  options: { announcePending: boolean },
): void {
  const ctx = (): EventContext => ({ ...correlation, eventId: Bun.randomUUIDv7(), occurredAt: now });

  if (outcome.status === WagerTransactionStatus.Processed) {
    if (outcome.entry) {
      repo.insertLedgerEntry(outcome.entry);
      repo.saveWallet(locked);
      repo.insertOutbox(OutboxMessage.enqueue(WalletBalanceChanged.from(locked.wallet, outcome.entry, ctx())));
    }
    repo.insertOutbox(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx())));
  } else if (outcome.status === WagerTransactionStatus.Rejected) {
    repo.insertOutbox(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, ctx())));
  } else if (options.announcePending) {
    repo.insertOutbox(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, ctx())));
  }
}

export function referenceBackoff(baseDelayMs: number, attempt: number, now: Date): Date {
  return new Date(now.getTime() + baseDelayMs * 2 ** attempt);
}