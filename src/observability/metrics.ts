import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const metrics = {
  transactions: new Counter({
    name: "wager_transactions_total",
    help: "Decided transactions by kind and status",
    labelNames: ["kind", "status", "source"] as const,
    registers: [registry],
  }),
  duplicates: new Counter({
    name: "wager_duplicates_total",
    help: "Duplicates detected: idempotent replays, inbox hits and idempotency conflicts",
    labelNames: ["type"] as const,
    registers: [registry],
  }),
  retries: new Counter({
    name: "wager_retries_total",
    help: "Retries by component",
    labelNames: ["component"] as const,
    registers: [registry],
  }),
  dlq: new Counter({
    name: "wager_dlq_messages_total",
    help: "Messages sent to the DLQ by this service, by reason",
    labelNames: ["reason"] as const,
    registers: [registry],
  }),
  lockConflicts: new Counter({
    name: "wager_lock_conflicts_total",
    help: "Unique-constraint races and lock timeouts resolved by retrying",
    registers: [registry],
  }),
  outboxLag: new Gauge({
    name: "wager_outbox_lag_seconds",
    help: "Age of the oldest unpublished outbox message",
    registers: [registry],
  }),
  outboxPending: new Gauge({
    name: "wager_outbox_pending",
    help: "Unpublished outbox messages",
    registers: [registry],
  }),
  reconciliationMismatches: new Counter({
    name: "wager_reconciliation_mismatches_total",
    help: "Wallets whose stored balance differs from the ledger",
    registers: [registry],
  }),
  processingSeconds: new Histogram({
    name: "wager_processing_seconds",
    help: "Time to process one transaction, including the SQL transaction",
    labelNames: ["source"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  }),
};