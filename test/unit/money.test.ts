import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/domain/errors";
import { Money } from "../../src/domain/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money", () => {
  test("serializes with a fixed scale of 2", () => {
    expect(brl("25").toString()).toBe("25.00");
    expect(brl("25.5").toString()).toBe("25.50");
    expect(brl("0.01").toJSON()).toEqual({ amount: "0.01", currency: "BRL" });
  });

  test("adds and subtracts exactly, where float would drift", () => {
    expect(brl("0.10").add(brl("0.20")).toString()).toBe("0.30");
    expect(brl("100.00").subtract(brl("80.00")).toString()).toBe("20.00");
    expect(brl("1.00").subtract(brl("1.01")).toString()).toBe("-0.01");
  });

  test("handles values far beyond Number.MAX_SAFE_INTEGER", () => {
    const big = brl("90071992547409919.99");
    expect(big.add(brl("0.01")).toString()).toBe("90071992547409920.00");
  });

  test.each(["NaN", "Infinity", "-Infinity", "1e3", "1E-2", "", " ", "1.234", "1,00", "01.00", ".5", "5.", "+1.00", "0x10"])(
    "rejects invalid amount %p",
    (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    },
  );

  test("rejects a number instead of a string", () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test("rejects negative values in input contracts, but parse accepts them", () => {
    expect(() => brl("-1.00")).toThrow(InvalidMoneyError);
    expect(Money.parse({ amount: "-1.00", currency: "BRL" }).isNegative()).toBe(true);
  });

  test("rejects invalid currency codes", () => {
    for (const currency of ["brl", "BR", "REAL", ""]) {
      expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
    }
  });

  test("refuses to mix currencies", () => {
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl("1.00").equals(usd)).toBe(false);
  });

  test("is immutable", () => {
    const a = brl("10.00");
    a.add(brl("5.00"));
    a.negate();
    expect(a.toString()).toBe("10.00");
  });

  test("comparisons", () => {
    expect(brl("0.00").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("1.00").negate().isNegative()).toBe(true);
    expect(brl("79.99").isLessThan(brl("80.00"))).toBe(true);
    expect(brl("80").equals(brl("80.00"))).toBe(true);
  });
});