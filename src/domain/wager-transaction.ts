import { DomainError, InvalidTransactionStateError } from "./errors";
import type { FailureCode } from "./failure-code";
import { LedgerDirection } from "./ledger-entry";
import { Money, type MoneyProps } from "./money";

export enum WagerTransactionKind {
  Opening = "OPENING", // internal: opening credit of a wallet
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Kinds a reversal may point to. */
export const REVERSIBLE_BY: Record<string, WagerTransactionKind[]> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends Omit<CreateWagerTransactionProps, "money"> {
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  balanceAfter?: MoneyProps | undefined;
  referenceAttempts: number;
  nextReferenceCheckAt?: Date | undefined;
}

export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    /** id at the provider, not the internal id */
    readonly referenceExternalTransactionId: string | undefined,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    /** Balance observed when the transaction was decided: what a replay must return. */
    private _balanceAfter?: Money,
    private _referenceAttempts = 0,
    private _nextReferenceCheckAt?: Date,
  ) {}

  /** Born PENDING. Validates the reference requirement per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new DomainError("INVALID_KIND", "OPENING is internal and cannot be submitted");
    }
    return WagerTransaction.build(props);
  }

  /** The only door to an OPENING transaction: used when a wallet is created. */
  static opening(props: Omit<CreateWagerTransactionProps, "kind" | "referenceExternalTransactionId">) {
    return WagerTransaction.build({ ...props, kind: WagerTransactionKind.Opening });
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    const needsReference = REVERSIBLE_BY[props.kind] !== undefined;
    if (needsReference && !props.referenceExternalTransactionId) {
      throw new DomainError("REFERENCE_REQUIRED", `${props.kind} requires referenceExternalTransactionId`);
    }
    if (props.money.isNegative() || (props.kind !== WagerTransactionKind.Loss && props.money.isZero())) {
      throw new DomainError("INVALID_AMOUNT", "amount must be positive");
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.parse(state.money),
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.balanceAfter ? Money.parse(state.balanceAfter) : undefined,
      state.referenceAttempts,
      state.nextReferenceCheckAt,
    );
  }

  get status() {
    return this._status;
  }
  get referenceTransactionId() {
    return this._referenceTransactionId;
  }
  get failureCode() {
    return this._failureCode;
  }
  get processedAt() {
    return this._processedAt;
  }
  get balanceAfter() {
    return this._balanceAfter;
  }
  get referenceAttempts() {
    return this._referenceAttempts;
  }
  get nextReferenceCheckAt() {
    return this._nextReferenceCheckAt;
  }

  // ---- transitions -------------------------------------------------------

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    this.transition(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._balanceAfter = balanceAfter;
    this._nextReferenceCheckAt = undefined;
  }

  /** Waits for the referenced transaction; may be called again to schedule the next check. */
  markPendingReference(nextCheckAt: Date): void {
    if (this._status === WagerTransactionStatus.PendingReference) {
      this._referenceAttempts += 1;
    } else {
      this.transition(WagerTransactionStatus.PendingReference);
    }
    this._nextReferenceCheckAt = nextCheckAt;
  }

  reject(code: FailureCode, at: Date, balanceAfter: Money): void {
    this.transition(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._processedAt = at;
    this._balanceAfter = balanceAfter;
    this._nextReferenceCheckAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.transition(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._processedAt = at;
  }

  // ---- queries -----------------------------------------------------------

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REVERSIBLE_BY[this.kind] !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** BET debits; WIN, REFUND and OPENING credit; ROLLBACK goes the opposite way of its reference. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new DomainError("REFERENCE_REQUIRED", "ROLLBACK needs its reference");
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new DomainError("NO_LEDGER", "LOSS does not move the balance");
    }
  }

  private transition(to: WagerTransactionStatus): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(this._status, to);
    this._status = to;
  }
}