import type { MikroORM } from "@mikro-orm/postgresql";
import { config } from "../config";
import { settle } from "../domain/settlement";
import { WagerTransactionRecord } from "../infra/db/records";
import { WageringRepository } from "../infra/db/wagering.repository";
import { log } from "../observability/logger";
import { metrics } from "../observability/metrics";
import { recordOutcome, referenceBackoff } from "./record-outcome";

/**
 * Looks again for the reference of PENDING_REFERENCE transactions.
 * Backoff 1s, 2s, 4s...; after maxAttempts the transaction is REJECTED with REFERENCE_NOT_FOUND.
 * Safe with many instances: each row is taken with FOR UPDATE SKIP LOCKED.
 */
export class PendingReferenceWorker {
  private timer: Timer | undefined;
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly orm: MikroORM,
    private readonly settings = config.pendingReference,
  ) {}

  start(): void {
    const tick = () => {
      this.running = this.runOnce()
        .catch((error) => log.error("pending reference worker failed", { error: String(error) }))
        .finally(() => {
          if (this.timer) this.timer = setTimeout(tick, this.settings.pollMs);
        });
    };
    this.timer = setTimeout(tick, this.settings.pollMs);
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** Processes the due transactions once. Returns how many it touched. */
  async runOnce(now = new Date()): Promise<number> {
    const due = await this.orm.em.fork().find(
      WagerTransactionRecord,
      { status: "PENDING_REFERENCE", nextReferenceCheckAt: { $lte: now } },
      { orderBy: { nextReferenceCheckAt: "asc" }, limit: 50, fields: ["id", "walletId"] },
    );
    let touched = 0;
    for (const { id, walletId } of due) {
      if (await this.retry(id, walletId, now)) touched++;
    }
    return touched;
  }

  private retry(id: string, walletId: string, now: Date): Promise<boolean> {
    return this.orm.em.fork().transactional(async (em) => {
      const repo = new WageringRepository(em);
      // Same lock order as the main path: wallet first, then the transaction row.
      const locked = await repo.lockWallet(walletId);
      const pending = await repo.lockPendingReference(id);
      if (!locked || !pending) return false;
      const { tx, record } = pending;
      const reference = await repo.findByExternalId(tx.providerId, tx.referenceExternalTransactionId!);
      const nextAttempt = tx.referenceAttempts + 1;
      const outcome = settle({
        wallet: locked.wallet,
        tx,
        reference,
        referenceAlreadyReversed: reference ? await repo.isReversed(reference.id) : false,
        entryId: Bun.randomUUIDv7(),
        now,
        nextReferenceCheckAt:
          nextAttempt < this.settings.maxAttempts ? referenceBackoff(this.settings.baseDelayMs, nextAttempt, now) : undefined,
      });
      repo.saveTransaction(record, tx);
      recordOutcome(repo, locked, tx, outcome, { correlationId: tx.id, causationId: tx.id }, now, {
        announcePending: false,
      });
      metrics.retries.inc({ component: "pending-reference" });
      if (tx.isTerminal()) {
        metrics.transactions.inc({ kind: tx.kind, status: tx.status, source: "pending-reference" });
        log.info("pending reference resolved", {
          transactionId: tx.id,
          walletId,
          providerId: tx.providerId,
          status: tx.status,
          failureCode: tx.failureCode,
        });
      }
      return true;
    });
  }
}