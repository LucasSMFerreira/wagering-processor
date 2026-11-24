import { z } from "zod";
import { Money } from "../domain/money";
import { WagerTransactionKind } from "../domain/wager-transaction";
import { canonicalJson, sha256 } from "./payload-hash";

const id = z.string().trim().min(1).max(200);

export const moneySchema = z
  .object({ amount: z.string(), currency: z.string() })
  .strict()
  .transform((value, ctx) => {
    try {
      return Money.from(value);
    } catch (error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
      return z.NEVER;
    }
  });

/** OPENING is internal: it is not accepted from the API nor from the queue. */
const submittableKinds = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

export const wagerTransactionSchema = z
  .object({
    providerId: id,
    externalTransactionId: id,
    playerId: id,
    walletId: z.string().uuid(),
    roundId: id,
    gameId: id,
    kind: z.enum(submittableKinds),
    money: moneySchema,
    referenceExternalTransactionId: id.optional(),
  })
  .strict()
  .refine(
    (v) => !(v.kind === WagerTransactionKind.Refund || v.kind === WagerTransactionKind.Rollback) || v.referenceExternalTransactionId,
    { message: "REFUND and ROLLBACK require referenceExternalTransactionId", path: ["referenceExternalTransactionId"] },
  );

export type WagerTransactionInput = z.infer<typeof wagerTransactionSchema>;

export interface ProcessWagerCommand extends WagerTransactionInput {
  idempotencyKey: string;
}

/**
 * SHA-256 of the canonical JSON of the business fields only.
 * The Idempotency-Key header, messageId and other transport metadata stay out.
 * money.amount is normalized ("25" and "25.00" are the same request).
 */
export function payloadHash(input: WagerTransactionInput): string {
  return sha256(
    canonicalJson({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: input.money.toJSON(),
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    }),
  );
}

export const createWalletSchema = z
  .object({ playerId: id, initialBalance: moneySchema })
  .strict();

export type CreateWalletInput = z.infer<typeof createWalletSchema>;