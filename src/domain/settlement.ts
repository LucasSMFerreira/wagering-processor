import { FailureCode } from "./failure-code";
import { LedgerDirection, type WalletLedgerEntry } from "./ledger-entry";
import { REVERSIBLE_BY, WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "./wager-transaction";
import type { Wallet } from "./wallet";

export interface SettleInput {
  wallet: Wallet;
  tx: WagerTransaction;
  /** The referenced transaction, already looked up by (providerId, referenceExternalTransactionId). */
  reference: WagerTransaction | undefined;
  /** True when a REFUND/ROLLBACK already reverted this reference. */
  referenceAlreadyReversed: boolean;
  entryId: string;
  now: Date;
  /** When to look for a missing reference again; undefined = stop waiting and reject. */
  nextReferenceCheckAt: Date | undefined;
}

export type SettleOutcome =
  | { status: WagerTransactionStatus.Processed; entry: WalletLedgerEntry | undefined }
  | { status: WagerTransactionStatus.Rejected; code: FailureCode }
  | { status: WagerTransactionStatus.PendingReference };

/** Kinds that WIN may point to (the reference is optional for WIN). */
const REFERABLE_BY_WIN = [WagerTransactionKind.Bet];

/**
 * Domain service: applies every rule of section 7 to one transaction.
 * Mutates the wallet and the transaction; returns what happened.
 */
export function settle(input: SettleInput): SettleOutcome {
  const { wallet, tx, reference, now } = input;

  const reject = (code: FailureCode): SettleOutcome => {
    tx.reject(code, now, wallet.balance);
    return { status: WagerTransactionStatus.Rejected, code };
  };

  if (wallet.playerId !== tx.playerId || wallet.id !== tx.walletId) return reject(FailureCode.WalletPlayerMismatch);
  if (wallet.currency !== tx.money.currency) return reject(FailureCode.CurrencyMismatch);

  const isReversal = tx.requiresReference();

  if (tx.referenceExternalTransactionId) {
    if (!reference || reference.status === WagerTransactionStatus.PendingReference) {
      if (input.nextReferenceCheckAt) {
        tx.markPendingReference(input.nextReferenceCheckAt);
        return { status: WagerTransactionStatus.PendingReference };
      }
      return reject(FailureCode.ReferenceNotFound);
    }
    const sameContext =
      reference.providerId === tx.providerId &&
      reference.playerId === tx.playerId &&
      reference.walletId === tx.walletId &&
      reference.money.currency === tx.money.currency &&
      reference.roundId === tx.roundId;
    if (!sameContext) return reject(FailureCode.ReferenceMismatch);

    const allowed = isReversal ? REVERSIBLE_BY[tx.kind]! : REFERABLE_BY_WIN;
    if (tx.kind === WagerTransactionKind.Loss || !allowed.includes(reference.kind)) {
      return reject(FailureCode.ReferenceInvalidKind);
    }
    if (reference.status !== WagerTransactionStatus.Processed) return reject(FailureCode.ReferenceNotProcessed);
    if (isReversal) {
      if (input.referenceAlreadyReversed) return reject(FailureCode.ReferenceAlreadyReversed);
      if (!reference.money.equals(tx.money)) return reject(FailureCode.ReversalAmountMismatch);
    }
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, now, wallet.balance);
    return { status: WagerTransactionStatus.Processed, entry: undefined };
  }

  const direction = tx.ledgerDirectionFor(reference);
  const movement = { entryId: input.entryId, transactionId: tx.id, money: tx.money, at: now };

  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    return reject(isReversal ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds);
  }
  const entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
  tx.markProcessed(reference?.id, now, wallet.balance);
  return { status: WagerTransactionStatus.Processed, entry };
}