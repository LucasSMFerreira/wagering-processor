import { CurrencyMismatchError, InvalidMoneyError } from "./errors";

export interface MoneyProps {
  amount: string; // decimal string with exactly 2 places, ex.: "25.00"
  currency: string; // ISO-4217
}

const AMOUNT_RE = /^-?(0|[1-9]\d*)(\.\d{1,2})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Immutable money with a fixed scale of 2.
 * The value lives in cents as a bigint: exact, no float anywhere.
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    readonly currency: string,
  ) {}

  /** Entry point for external contracts: rejects negatives. */
  static from(props: MoneyProps): Money {
    const money = Money.parse(props);
    if (money.isNegative()) throw new InvalidMoneyError("amount must not be negative");
    return money;
  }

  /** Internal parsing, accepts negatives (ex.: a value read back from the database). */
  static parse(props: MoneyProps): Money {
    if (typeof props?.amount !== "string") throw new InvalidMoneyError("amount must be a string");
    if (typeof props.currency !== "string" || !CURRENCY_RE.test(props.currency)) {
      throw new InvalidMoneyError("currency must be ISO-4217, ex.: BRL");
    }
    const amount = props.amount;
    if (!AMOUNT_RE.test(amount)) throw new InvalidMoneyError(`invalid amount: "${amount}"`);
    const negative = amount.startsWith("-");
    const [whole = "0", fraction = ""] = amount.replace("-", "").split(".");
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    return new Money(negative ? -cents : cents, props.currency);
  }

  static zero(currency: string): Money {
    return Money.parse({ amount: "0", currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Always 2 places: "25.00", "-0.50". */
  toString(): string {
    const abs = this.cents < 0n ? -this.cents : this.cents;
    const whole = abs / 100n;
    const fraction = (abs % 100n).toString().padStart(2, "0");
    return `${this.cents < 0n ? "-" : ""}${whole}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}