import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InsufficientFundsError } from "../../src/domain/errors";
import { LedgerDirection, WalletLedgerEntry } from "../../src/domain/ledger-entry";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-11-24T12:00:00Z");

function open(initial: string) {
  return Wallet.open({
    id: "w1",
    playerId: "p1",
    initialBalance: brl(initial),
    openingTransactionId: "t0",
    openingEntryId: "e0",
    at,
  });
}

describe("Wallet", () => {
  test("opens at version 1 with an OPENING credit entry", () => {
    const { wallet, openingEntry } = open("1000.00");
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe("1000.00");
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe("0.00");
    expect(openingEntry?.balanceAfter.toString()).toBe("1000.00");
  });

  test("zero initial balance has no ledger entry", () => {
    const { wallet, openingEntry } = open("0.00");
    expect(openingEntry).toBeUndefined();
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("debit and credit move the balance and bump the version", () => {
    const { wallet } = open("100.00");
    const debit = wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("30.00"), at });
    expect(debit.balanceBefore.toString()).toBe("100.00");
    expect(debit.balanceAfter.toString()).toBe("70.00");
    wallet.credit({ entryId: "e2", transactionId: "t2", money: brl("5.50"), at });
    expect(wallet.balance.toString()).toBe("75.50");
    expect(wallet.version).toBe(3);
  });

  test("never goes negative", () => {
    const { wallet } = open("100.00");
    expect(() => wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("100.01"), at })).toThrow(
      InsufficientFundsError,
    );
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("debiting the whole balance is fine", () => {
    const { wallet } = open("80.00");
    wallet.debit({ entryId: "e1", transactionId: "t1", money: brl("80.00"), at });
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("refuses another currency", () => {
    const { wallet } = open("100.00");
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => wallet.credit({ entryId: "e1", transactionId: "t1", money: usd, at })).toThrow(CurrencyMismatchError);
  });

  test("rehydrate keeps the persisted state as is", () => {
    const wallet = Wallet.rehydrate({
      id: "w1",
      playerId: "p1",
      currency: "BRL",
      balance: { amount: "12.34", currency: "BRL" },
      version: 7,
      createdAt: at,
      updatedAt: at,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toString()).toBe("12.34");
  });
});

describe("WalletLedgerEntry", () => {
  test("refuses a non-positive amount", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: "e",
        walletId: "w",
        transactionId: "t",
        direction: LedgerDirection.Credit,
        money: brl("0.00"),
        balanceBefore: brl("1.00"),
        createdAt: at,
      }),
    ).toThrow();
  });

  test("rehydrated entry that does not balance is detectable", () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: "e",
      walletId: "w",
      transactionId: "t",
      direction: LedgerDirection.Debit,
      money: { amount: "10.00", currency: "BRL" },
      balanceBefore: { amount: "50.00", currency: "BRL" },
      balanceAfter: { amount: "45.00", currency: "BRL" },
      createdAt: at,
    });
    expect(entry.isBalanced()).toBe(false);
  });
});