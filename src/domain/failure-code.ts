/**
 * Stable, machine-readable reasons. The provider decides from the code alone:
 * - "fix-payload": the request is wrong, resend only after fixing it;
 * - "give-up": the request is valid but the state does not allow it, resending changes nothing;
 * - "retry-later": a transient condition, the same request may succeed later.
 */
export const FailureCode = {
  InsufficientFunds: "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds: "REVERSAL_INSUFFICIENT_FUNDS",
  CurrencyMismatch: "CURRENCY_MISMATCH",
  WalletPlayerMismatch: "WALLET_PLAYER_MISMATCH",
  WalletNotFound: "WALLET_NOT_FOUND",
  ReferenceNotFound: "REFERENCE_NOT_FOUND",
  ReferenceMismatch: "REFERENCE_MISMATCH",
  ReferenceInvalidKind: "REFERENCE_INVALID_KIND",
  ReferenceNotProcessed: "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed: "REFERENCE_ALREADY_REVERSED",
  ReversalAmountMismatch: "REVERSAL_AMOUNT_MISMATCH",
  ProcessingFailed: "PROCESSING_FAILED",
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

export const failureAction: Record<FailureCode, "fix-payload" | "give-up" | "retry-later"> = {
  INSUFFICIENT_FUNDS: "give-up",
  REVERSAL_INSUFFICIENT_FUNDS: "give-up",
  CURRENCY_MISMATCH: "fix-payload",
  WALLET_PLAYER_MISMATCH: "fix-payload",
  WALLET_NOT_FOUND: "fix-payload",
  REFERENCE_NOT_FOUND: "fix-payload",
  REFERENCE_MISMATCH: "fix-payload",
  REFERENCE_INVALID_KIND: "fix-payload",
  REFERENCE_NOT_PROCESSED: "give-up",
  REFERENCE_ALREADY_REVERSED: "give-up",
  REVERSAL_AMOUNT_MISMATCH: "fix-payload",
  PROCESSING_FAILED: "retry-later",
};