import { describe, expect, test } from "bun:test";
import { payloadHash, wagerTransactionSchema } from "../../src/app/commands";
import { canonicalJson } from "../../src/app/payload-hash";

const body = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("canonical JSON and payload hash", () => {
  test("key order does not matter", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("same business content gives the same hash, whatever the order or the amount spelling", () => {
    const reordered = Object.fromEntries(Object.entries(body).reverse());
    const a = payloadHash(wagerTransactionSchema.parse(body));
    const b = payloadHash(wagerTransactionSchema.parse({ ...reordered, money: { currency: "BRL", amount: "25" } }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a different amount gives a different hash", () => {
    const a = payloadHash(wagerTransactionSchema.parse(body));
    const b = payloadHash(wagerTransactionSchema.parse({ ...body, money: { amount: "25.01", currency: "BRL" } }));
    expect(a).not.toBe(b);
  });

  test("the schema refuses OPENING, unknown fields and REFUND without reference", () => {
    expect(wagerTransactionSchema.safeParse({ ...body, kind: "OPENING" }).success).toBe(false);
    expect(wagerTransactionSchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
    expect(wagerTransactionSchema.safeParse({ ...body, kind: "REFUND" }).success).toBe(false);
    expect(wagerTransactionSchema.safeParse({ ...body, money: { amount: 25, currency: "BRL" } }).success).toBe(false);
  });
});