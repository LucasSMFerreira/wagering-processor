import { describe, expect, test } from "bun:test";
import { WalletBalanceChanged } from "../../src/domain/events";
import { InboxMessage, OutboxMessage } from "../../src/domain/messages";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";

const at = new Date("2026-11-24T12:00:00.000Z");

function event() {
  const { wallet, openingEntry } = Wallet.open({
    id: "w1",
    playerId: "p1",
    initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
    openingTransactionId: "t0",
    openingEntryId: "e0",
    at,
  });
  return WalletBalanceChanged.from(wallet, openingEntry!, { eventId: "ev1", correlationId: "c1", occurredAt: at });
}

describe("integration events", () => {
  test("type and version live in the class, money travels as strings", () => {
    // JSON round trip: what really goes into the outbox payload
    expect(JSON.parse(JSON.stringify(event()))).toEqual({
      eventId: "ev1",
      eventType: "WalletBalanceChanged",
      aggregateId: "w1",
      correlationId: "c1",
      occurredAt: "2026-11-24T12:00:00.000Z",
      version: 1,
      data: {
        walletId: "w1",
        transactionId: "t0",
        direction: "CREDIT",
        money: { amount: "10.00", currency: "BRL" },
        balanceBefore: { amount: "0.00", currency: "BRL" },
        balanceAfter: { amount: "10.00", currency: "BRL" },
        walletVersion: 1,
      },
    });
  });

  test("data cannot be changed after creation", () => {
    expect(() => {
      (event().data as { walletId: string }).walletId = "other";
    }).toThrow();
  });
});

describe("OutboxMessage", () => {
  test("is due right away and backs off exponentially", () => {
    const message = OutboxMessage.enqueue(event());
    expect(message.isDue(at)).toBe(true);
    message.scheduleRetry(at);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(new Date(at.getTime() + 1000));
    expect(message.isDue(at)).toBe(false);
    message.scheduleRetry(at);
    expect(message.nextAttemptAt).toEqual(new Date(at.getTime() + 2000));
  });

  test("backoff is capped at 5 minutes", () => {
    const message = OutboxMessage.enqueue(event());
    for (let i = 0; i < 30; i++) message.scheduleRetry(at);
    expect(message.nextAttemptAt).toEqual(new Date(at.getTime() + 300_000));
  });

  test("published is final", () => {
    const message = OutboxMessage.enqueue(event());
    message.markPublished(at);
    message.markPublished(new Date());
    expect(message.publishedAt).toEqual(at);
    expect(message.isPending()).toBe(false);
  });
});

describe("InboxMessage", () => {
  test("is processed once", () => {
    const inbox = InboxMessage.receive({ messageId: "m1", consumerName: "c", payloadHash: "h", receivedAt: at });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(at);
    expect(inbox.isProcessed()).toBe(true);
  });
});