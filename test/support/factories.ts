import type { MikroORM } from "@mikro-orm/postgresql";
import type { ProcessWagerCommand } from "../../src/app/commands";
import { ProcessWagerTransaction } from "../../src/app/process-wager.use-case";
import { CreateWallet } from "../../src/app/wallets.use-cases";
import { Money } from "../../src/domain/money";
import { WagerTransactionKind } from "../../src/domain/wager-transaction";

export const correlation = { correlationId: "test" };

export async function createWallet(orm: MikroORM, balance: string, playerId = crypto.randomUUID()) {
  const result = await new CreateWallet(orm).execute(
    { playerId, initialBalance: Money.from({ amount: balance, currency: "BRL" }) },
    correlation,
  );
  if (result.kind !== "created") throw new Error("wallet not created");
  return result.wallet;
}

let seq = 0;

export function command(
  wallet: { id: string; playerId: string },
  kind: `${WagerTransactionKind}`,
  amount: string,
  extra: Partial<ProcessWagerCommand> = {},
): ProcessWagerCommand {
  seq += 1;
  const externalTransactionId = extra.externalTransactionId ?? `tx-${Date.now()}-${seq}`;
  const providerId = extra.providerId ?? "provider-a";
  return {
    providerId,
    externalTransactionId,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: kind as Exclude<WagerTransactionKind, WagerTransactionKind.Opening>,
    money: Money.from({ amount, currency: "BRL" }),
    ...extra,
  };
}

export function useCase(orm: MikroORM) {
  return new ProcessWagerTransaction(orm);
}