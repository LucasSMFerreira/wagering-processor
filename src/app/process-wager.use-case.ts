import type { MikroORM } from "@mikro-orm/postgresql";
import { config } from "../config";
import { FailureCode } from "../domain/failure-code";
import { InboxMessage } from "../domain/messages";
import { settle } from "../domain/settlement";
import { WagerTransaction } from "../domain/wager-transaction";
import { WageringRepository } from "../infra/db/wagering.repository";
import { log } from "../observability/logger";
import { metrics } from "../observability/metrics";
import { type ProcessWagerCommand, payloadHash } from "./commands";
import { isUniqueViolation } from "./errors";
import { type Correlation, recordOutcome, referenceBackoff } from "./record-outcome";

export interface InboxSource {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export type ProcessResult =
  | { kind: "decided"; transaction: WagerTransaction; replay: boolean }
  | { kind: "idempotency-conflict"; transactionId: string }
  | { kind: "wallet-not-found" }
  | { kind: "duplicate-message" };

const MAX_ATTEMPTS = 3;

/**
 * The single use case behind POST /wagering/transactions and the SQS consumer.
 *
 * One SQL transaction does everything: inbox, wallet lock, idempotency check,
 * business rules, transaction row, ledger entry, wallet update and outbox events.
 */
export class ProcessWagerTransaction {
  constructor(private readonly orm: MikroORM) {}

  async execute(command: ProcessWagerCommand, correlation: Correlation, inbox?: InboxSource): Promise<ProcessResult> {
    const source = inbox ? "sqs" : "http";
    const stop = metrics.processingSeconds.startTimer({ source });
    const hash = payloadHash(command);
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await this.orm.em.fork().transactional((em) =>
            this.run(new WageringRepository(em), command, hash, correlation, inbox),
          );
          this.observe(result, source, command, correlation);
          return result;
        } catch (error) {
          // A unique index refused our insert: someone else committed the same key first.
          // Running again turns it into a replay or a conflict, decided by the database.
          if (isUniqueViolation(error) && attempt < MAX_ATTEMPTS) {
            metrics.lockConflicts.inc();
            metrics.retries.inc({ component: "process-wager" });
            continue;
          }
          throw error;
        }
      }
    } finally {
      stop();
    }
  }

  private async run(
    repo: WageringRepository,
    command: ProcessWagerCommand,
    hash: string,
    correlation: Correlation,
    inbox: InboxSource | undefined,
  ): Promise<ProcessResult> {
    const now = new Date();

    if (inbox) {
      const fresh = await repo.receiveInbox(InboxMessage.receive({ ...inbox, receivedAt: now }));
      if (!fresh) return { kind: "duplicate-message" };
    }

    // The row lock comes first: every request for this wallet waits here, one at a time.
    const locked = await repo.lockWallet(command.walletId);

    const existing = await repo.findByIdempotencyKey(command.idempotencyKey);
    if (existing) {
      return existing.matchesPayload(hash)
        ? { kind: "decided", transaction: existing, replay: true }
        : { kind: "idempotency-conflict", transactionId: existing.id };
    }
    const sameExternalId = await repo.findByExternalId(command.providerId, command.externalTransactionId);
    if (sameExternalId) return { kind: "idempotency-conflict", transactionId: sameExternalId.id };

    if (!locked) return { kind: "wallet-not-found" };

    const tx = WagerTransaction.create({
      id: Bun.randomUUIDv7(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: hash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    const reference = command.referenceExternalTransactionId
      ? await repo.findByExternalId(command.providerId, command.referenceExternalTransactionId)
      : undefined;
    const outcome = settle({
      wallet: locked.wallet,
      tx,
      reference,
      referenceAlreadyReversed: reference ? await repo.isReversed(reference.id) : false,
      entryId: Bun.randomUUIDv7(),
      now,
      nextReferenceCheckAt: referenceBackoff(config.pendingReference.baseDelayMs, 0, now),
    });

    repo.insertTransaction(tx);
    recordOutcome(repo, locked, tx, outcome, correlation, now, { announcePending: true });
    return { kind: "decided", transaction: tx, replay: false };
  }

  private observe(result: ProcessResult, source: string, command: ProcessWagerCommand, correlation: Correlation) {
    const ctx = {
      correlationId: correlation.correlationId,
      providerId: command.providerId,
      walletId: command.walletId,
    };
    switch (result.kind) {
      case "decided": {
        const tx = result.transaction;
        if (result.replay) {
          metrics.duplicates.inc({ type: "idempotent-replay" });
          log.info("idempotent replay", { ...ctx, transactionId: tx.id, status: tx.status });
        } else {
          metrics.transactions.inc({ kind: tx.kind, status: tx.status, source });
          log.info("transaction decided", {
            ...ctx,
            transactionId: tx.id,
            kind: tx.kind,
            status: tx.status,
            failureCode: tx.failureCode,
          });
        }
        return;
      }
      case "idempotency-conflict":
        metrics.duplicates.inc({ type: "idempotency-conflict" });
        log.warn("idempotency conflict", { ...ctx, transactionId: result.transactionId });
        return;
      case "duplicate-message":
        metrics.duplicates.inc({ type: "inbox" });
        log.info("duplicate message ignored", ctx);
        return;
      case "wallet-not-found":
        log.info("wallet not found", { ...ctx, failureCode: FailureCode.WalletNotFound });
    }
  }
}