/** Base for every rule the domain refuses. Never thrown for infrastructure problems. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super("INVALID_MONEY", message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, received: string) {
    super("CURRENCY_MISMATCH", `expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super("INSUFFICIENT_FUNDS", "balance would become negative");
  }
}

/** A programming error: someone tried to move a transaction out of a terminal state. */
export class InvalidTransactionStateError extends Error {
  constructor(from: string, to: string) {
    super(`cannot move transaction from ${from} to ${to}`);
    this.name = "InvalidTransactionStateError";
  }
}