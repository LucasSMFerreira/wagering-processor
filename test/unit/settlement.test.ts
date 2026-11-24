import { describe, expect, test } from "bun:test";
import { InvalidTransactionStateError } from "../../src/domain/errors";
import { FailureCode } from "../../src/domain/failure-code";
import { LedgerDirection } from "../../src/domain/ledger-entry";
import { Money } from "../../src/domain/money";
import { settle } from "../../src/domain/settlement";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wager-transaction";
import { Wallet } from "../../src/domain/wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const now = new Date("2026-11-24T12:00:00Z");
const later = new Date("2026-11-24T12:00:05Z");
let seq = 0;

function wallet(balance: string) {
  return Wallet.open({
    id: "w1",
    playerId: "p1",
    initialBalance: brl(balance),
    openingTransactionId: "t0",
    openingEntryId: "e0",
    at: now,
  }).wallet;
}

function tx(kind: WagerTransactionKind, amount: string, extra: Partial<{ ref: string; round: string; player: string; currency: string }> = {}) {
  seq += 1;
  return WagerTransaction.create({
    id: `tx-${seq}`,
    providerId: "provider-a",
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `provider-a:ext-${seq}`,
    payloadHash: "hash",
    walletId: "w1",
    playerId: extra.player ?? "p1",
    roundId: extra.round ?? "round-1",
    gameId: "game",
    kind,
    money: Money.from({ amount, currency: extra.currency ?? "BRL" }),
    referenceExternalTransactionId: extra.ref,
    createdAt: now,
  });
}

function run(w: Wallet, t: WagerTransaction, reference?: WagerTransaction, alreadyReversed = false, wait: Date | null = later) {
  return settle({ wallet: w, tx: t, reference, referenceAlreadyReversed: alreadyReversed, entryId: `e-${t.id}`, now, nextReferenceCheckAt: wait ?? undefined });
}

function processedBet(w: Wallet, amount: string) {
  const bet = tx(WagerTransactionKind.Bet, amount);
  run(w, bet);
  return bet;
}

describe("BET", () => {
  test("debits and records the balance it saw", () => {
    const w = wallet("100.00");
    const bet = tx(WagerTransactionKind.Bet, "25.00");
    const out = run(w, bet);
    expect(out.status).toBe(WagerTransactionStatus.Processed);
    expect(out.status === WagerTransactionStatus.Processed && out.entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toString()).toBe("75.00");
    expect(bet.balanceAfter?.toString()).toBe("75.00");
  });

  test("insufficient funds is a rejection without ledger", () => {
    const w = wallet("10.00");
    const bet = tx(WagerTransactionKind.Bet, "10.01");
    const out = run(w, bet);
    expect(out).toEqual({ status: WagerTransactionStatus.Rejected, code: FailureCode.InsufficientFunds });
    expect(w.balance.toString()).toBe("10.00");
    expect(w.version).toBe(1);
  });

  test("currency mismatch is rejected", () => {
    const w = wallet("10.00");
    const out = run(w, tx(WagerTransactionKind.Bet, "1.00", { currency: "USD" }));
    expect(out).toEqual({ status: WagerTransactionStatus.Rejected, code: FailureCode.CurrencyMismatch });
  });

  test("a wallet of another player is rejected", () => {
    const w = wallet("10.00");
    const out = run(w, tx(WagerTransactionKind.Bet, "1.00", { player: "p2" }));
    expect(out).toEqual({ status: WagerTransactionStatus.Rejected, code: FailureCode.WalletPlayerMismatch });
  });
});

describe("WIN and LOSS", () => {
  test("WIN credits", () => {
    const w = wallet("10.00");
    run(w, tx(WagerTransactionKind.Win, "50.00"));
    expect(w.balance.toString()).toBe("60.00");
  });

  test("WIN may reference the BET of the same round", () => {
    const w = wallet("10.00");
    const bet = processedBet(w, "10.00");
    const win = tx(WagerTransactionKind.Win, "30.00", { ref: bet.externalTransactionId });
    expect(run(w, win, bet).status).toBe(WagerTransactionStatus.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
  });

  test("LOSS is processed without moving the balance", () => {
    const w = wallet("10.00");
    const loss = tx(WagerTransactionKind.Loss, "0.00");
    const out = run(w, loss);
    expect(out).toEqual({ status: WagerTransactionStatus.Processed, entry: undefined });
    expect(w.version).toBe(1);
    expect(loss.affectsBalance()).toBe(false);
  });
});

describe("REFUND", () => {
  test("requires a reference", () => {
    expect(() => tx(WagerTransactionKind.Refund, "1.00")).toThrow();
  });

  test("credits back a processed BET", () => {
    const w = wallet("100.00");
    const bet = processedBet(w, "40.00");
    const out = run(w, tx(WagerTransactionKind.Refund, "40.00", { ref: bet.externalTransactionId }), bet);
    expect(out.status).toBe(WagerTransactionStatus.Processed);
    expect(w.balance.toString()).toBe("100.00");
  });

  test("only references a BET", () => {
    const w = wallet("100.00");
    const win = tx(WagerTransactionKind.Win, "5.00");
    run(w, win);
    const out = run(w, tx(WagerTransactionKind.Refund, "5.00", { ref: win.externalTransactionId }), win);
    expect(out).toEqual({ status: WagerTransactionStatus.Rejected, code: FailureCode.ReferenceInvalidKind });
  });

  test("must have the same amount", () => {
    const w = wallet("100.00");
    const bet = processedBet(w, "40.00");
    const out = run(w, tx(WagerTransactionKind.Refund, "20.00", { ref: bet.externalTransactionId }), bet);
    expect(out).toEqual({ status: WagerTransactionStatus.Rejected, code: FailureCode.ReversalAmountMismatch });
  });

  test("cannot revert twice", () => {
    const w = wallet("100.00");
    const bet = processedBet(w, "40.00");
    const out = run(w, tx(WagerTransactionKind.Refund, "40.00", { ref: bet.externalTransactionId }), bet, true);
    expect(out).toEqual({ status: WagerTransactionStatus.Rejected, code: FailureCode.ReferenceAlreadyReversed });
  });

  test("must be in the same round", () => {
    const w = wallet("100.00");
    const bet = processedBet(w, "40.00");
    const out = run(w, tx(WagerTransactionKind.Refund, "40.00", { ref: bet.externalTransactionId, round: "other" }), bet);
    expect(out).toEqual({ status: WagerTransactionStatus.Rejected, code: FailureCode.ReferenceMismatch });
  });

  test("a rejected BET cannot be refunded", () => {
    const w = wallet("1.00");
    const bet = tx(WagerTransactionKind.Bet, "40.00");
    run(w, bet);
    const out = run(w, tx(WagerTransactionKind.Refund, "40.00", { ref: bet.externalTransactionId }), bet);
    expect(out).toEqual({ status: WagerTransactionStatus.Rejected, code: FailureCode.ReferenceNotProcessed });
  });

  test("missing reference waits, then gives up", () => {
    const w = wallet("100.00");
    const refund = tx(WagerTransactionKind.Refund, "40.00", { ref: "not-yet" });
    expect(run(w, refund).status).toBe(WagerTransactionStatus.PendingReference);
    expect(refund.nextReferenceCheckAt).toEqual(later);
    expect(run(w, refund, undefined, false, null)).toEqual({
      status: WagerTransactionStatus.Rejected,
      code: FailureCode.ReferenceNotFound,
    });
  });
});

describe("ROLLBACK", () => {
  test("of a BET credits", () => {
    const w = wallet("100.00");
    const bet = processedBet(w, "40.00");
    run(w, tx(WagerTransactionKind.Rollback, "40.00", { ref: bet.externalTransactionId }), bet);
    expect(w.balance.toString()).toBe("100.00");
  });

  test("of a WIN debits", () => {
    const w = wallet("0.00");
    const win = tx(WagerTransactionKind.Win, "30.00");
    run(w, win);
    const rb = tx(WagerTransactionKind.Rollback, "30.00", { ref: win.externalTransactionId });
    const out = run(w, rb, win);
    expect(out.status === WagerTransactionStatus.Processed && out.entry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.isZero()).toBe(true);
  });

  test("of a WIN already spent is rejected with its own code", () => {
    const w = wallet("0.00");
    const win = tx(WagerTransactionKind.Win, "30.00");
    run(w, win);
    processedBet(w, "25.00");
    const out = run(w, tx(WagerTransactionKind.Rollback, "30.00", { ref: win.externalTransactionId }), win);
    expect(out).toEqual({ status: WagerTransactionStatus.Rejected, code: FailureCode.ReversalInsufficientFunds });
    expect(w.balance.toString()).toBe("5.00");
  });

  test("of a REFUND debits again", () => {
    const w = wallet("100.00");
    const bet = processedBet(w, "40.00");
    const refund = tx(WagerTransactionKind.Refund, "40.00", { ref: bet.externalTransactionId });
    run(w, refund, bet);
    run(w, tx(WagerTransactionKind.Rollback, "40.00", { ref: refund.externalTransactionId }), refund);
    expect(w.balance.toString()).toBe("60.00");
  });

  test("of a LOSS is an invalid kind", () => {
    const w = wallet("100.00");
    const loss = tx(WagerTransactionKind.Loss, "0.00");
    run(w, loss);
    const out = run(w, tx(WagerTransactionKind.Rollback, "1.00", { ref: loss.externalTransactionId }), loss);
    expect(out).toEqual({ status: WagerTransactionStatus.Rejected, code: FailureCode.ReferenceInvalidKind });
  });
});

describe("WagerTransaction states", () => {
  test("terminal states do not move", () => {
    const w = wallet("100.00");
    const bet = processedBet(w, "1.00");
    expect(bet.isTerminal()).toBe(true);
    expect(() => bet.reject(FailureCode.InsufficientFunds, now, w.balance)).toThrow(InvalidTransactionStateError);
    expect(() => bet.markPendingReference(later)).toThrow(InvalidTransactionStateError);
  });

  test("OPENING cannot be submitted", () => {
    expect(() => tx(WagerTransactionKind.Opening, "1.00")).toThrow();
  });

  test("matchesPayload compares the hash", () => {
    const t = tx(WagerTransactionKind.Bet, "1.00");
    expect(t.matchesPayload("hash")).toBe(true);
    expect(t.matchesPayload("other")).toBe(false);
  });
});