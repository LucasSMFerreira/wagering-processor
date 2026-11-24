import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { FailureCode } from "../../domain/failure-code";
import { type LedgerDirection, WalletLedgerEntry } from "../../domain/ledger-entry";
import type { InboxMessage, OutboxMessage } from "../../domain/messages";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../domain/wager-transaction";
import { Wallet } from "../../domain/wallet";
import {
  InboxRecord,
  LedgerEntryRecord,
  OutboxRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "./records";

/** A locked wallet: the domain object plus the tracked row it came from. */
export interface LockedWallet {
  wallet: Wallet;
  record: WalletRecord;
}

/**
 * Every read and write of the financial path. Always receives the transactional
 * EntityManager, so nothing here can run outside the caller's SQL transaction.
 */
export class WageringRepository {
  constructor(private readonly em: EntityManager) {}

  // ---- wallets -----------------------------------------------------------

  /** SELECT ... FOR UPDATE: the row lock is the serialization point per wallet. */
  async lockWallet(walletId: string): Promise<LockedWallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? { wallet: toWallet(record), record } : undefined;
  }

  async findWallet(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id: walletId });
    return record ? toWallet(record) : undefined;
  }

  insertWallet(wallet: Wallet): void {
    this.em.persist(this.em.create(WalletRecord, walletRow(wallet)));
  }

  /** Copies the new balance and version to the tracked row; the flush issues the UPDATE. */
  saveWallet(locked: LockedWallet): void {
    if (locked.record.version === locked.wallet.version) return;
    this.em.assign(locked.record, walletRow(locked.wallet));
  }

  // ---- transactions ------------------------------------------------------

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { idempotencyKey: key });
    return record ? toTransaction(record) : undefined;
  }

  async findByExternalId(providerId: string, externalTransactionId: string) {
    const record = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return record ? toTransaction(record) : undefined;
  }

  async findTransaction(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { id });
    return record ? toTransaction(record) : undefined;
  }

  /** Locks one PENDING_REFERENCE row, skipping it if another worker already has it. */
  async lockPendingReference(id: string): Promise<{ tx: WagerTransaction; record: WagerTransactionRecord } | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { id, status: "PENDING_REFERENCE" },
      { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, refresh: true }, // FOR UPDATE SKIP LOCKED
    );
    return record ? { tx: toTransaction(record), record } : undefined;
  }

  async isReversed(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      status: "PROCESSED",
      kind: { $in: ["REFUND", "ROLLBACK"] },
    });
    return count > 0;
  }

  insertTransaction(tx: WagerTransaction): void {
    this.em.persist(this.em.create(WagerTransactionRecord, transactionRow(tx)));
  }

  saveTransaction(record: WagerTransactionRecord, tx: WagerTransaction): void {
    this.em.assign(record, transactionRow(tx));
  }

  // ---- ledger, outbox, inbox --------------------------------------------

  insertLedgerEntry(entry: WalletLedgerEntry): void {
    this.em.persist(
      this.em.create(LedgerEntryRecord, {
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: entry.money.toString(),
        currency: entry.money.currency,
        balanceBefore: entry.balanceBefore.toString(),
        balanceAfter: entry.balanceAfter.toString(),
        createdAt: entry.createdAt,
      }),
    );
  }

  insertOutbox(message: OutboxMessage): void {
    this.em.persist(
      this.em.create(OutboxRecord, {
        id: message.id,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        payload: message.payload as Record<string, unknown>,
        occurredAt: message.occurredAt,
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
      }),
    );
  }

  /**
   * INSERT ... ON CONFLICT DO NOTHING. Returns false when the message was already
   * recorded (a concurrent insert of the same key waits for the other commit first).
   */
  async receiveInbox(message: InboxMessage): Promise<boolean> {
    const result = await this.em
      .createQueryBuilder(InboxRecord)
      .insert({
        consumerName: message.consumerName,
        messageId: message.messageId,
        payloadHash: message.payloadHash,
        receivedAt: message.receivedAt,
        processedAt: message.receivedAt,
      })
      .onConflict(["consumerName", "messageId"])
      .ignore()
      .execute("run");
    return result.affectedRows > 0;
  }

  async ledgerPage(walletId: string, afterSeq: string | undefined, limit: number) {
    const rows = await this.em.find(
      LedgerEntryRecord,
      afterSeq ? { walletId, seq: { $gt: afterSeq } } : { walletId },
      { orderBy: { seq: "asc" }, limit: limit + 1 },
    );
    return rows;
  }
}

// ---- mappers -------------------------------------------------------------

export function toWallet(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: { amount: r.balanceAmount, currency: r.currency },
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

function walletRow(w: Wallet): WalletRecord {
  return {
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balanceAmount: w.balance.toString(),
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export function toTransaction(r: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as WagerTransactionKind,
    money: { amount: r.amount, currency: r.currency },
    referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
    createdAt: r.createdAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.referenceTransactionId ?? undefined,
    failureCode: (r.failureCode as FailureCode | null) ?? undefined,
    processedAt: r.processedAt ?? undefined,
    balanceAfter: r.balanceAfterAmount ? { amount: r.balanceAfterAmount, currency: r.currency } : undefined,
    referenceAttempts: r.referenceAttempts,
    nextReferenceCheckAt: r.nextReferenceCheckAt ?? undefined,
  });
}

function transactionRow(tx: WagerTransaction): WagerTransactionRecord {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    amount: tx.money.toString(),
    currency: tx.money.currency,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    balanceAfterAmount: tx.balanceAfter?.toString() ?? null,
    processedAt: tx.processedAt ?? null,
    referenceAttempts: tx.referenceAttempts,
    nextReferenceCheckAt: tx.nextReferenceCheckAt ?? null,
    createdAt: tx.createdAt,
  };
}

export function toLedgerEntry(r: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    direction: r.direction as LedgerDirection,
    money: { amount: r.amount, currency: r.currency },
    balanceBefore: { amount: r.balanceBefore, currency: r.currency },
    balanceAfter: { amount: r.balanceAfter, currency: r.currency },
    createdAt: r.createdAt,
  });
}