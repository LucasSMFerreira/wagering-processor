/** All configuration comes from environment variables, with local defaults. */
const env = (name: string, fallback: string) => process.env[name] ?? fallback;
const int = (name: string, fallback: number) => Number.parseInt(env(name, String(fallback)), 10);

export const config = {
  port: int("PORT", 3000),
  instanceId: env("INSTANCE_ID", `pid-${process.pid}`),
  databaseUrl: env("DATABASE_URL", "postgres://wagering:wagering@localhost:5432/wagering"),
  dbPoolMax: int("DB_POOL_MAX", 20),
  aws: {
    endpoint: env("AWS_ENDPOINT_URL", "http://localhost:4566"),
    region: env("AWS_REGION", "us-east-1"),
  },
  queues: {
    transactions: env("SQS_TRANSACTIONS_QUEUE", "wager-transactions.fifo"),
    events: env("SQS_EVENTS_QUEUE", "wagering-events"),
  },
  workers: {
    consumer: env("RUN_CONSUMER", "true") === "true",
    outbox: env("RUN_OUTBOX", "true") === "true",
    pendingReference: env("RUN_PENDING_REFERENCE", "true") === "true",
  },
  sqs: {
    /** Receive count after which SQS moves the message to the DLQ (redrive policy). */
    maxReceiveCount: int("SQS_MAX_RECEIVE_COUNT", 5),
    waitTimeSeconds: int("SQS_WAIT_SECONDS", 5),
    visibilityTimeoutSeconds: int("SQS_VISIBILITY_SECONDS", 30),
  },
  pendingReference: {
    /** 1s, 2s, 4s ... 512s: about 17 minutes of waiting in total with 10 attempts. */
    maxAttempts: int("PENDING_REFERENCE_MAX_ATTEMPTS", 10),
    baseDelayMs: int("PENDING_REFERENCE_BASE_DELAY_MS", 1000),
    pollMs: int("PENDING_REFERENCE_POLL_MS", 1000),
  },
  outbox: {
    pollMs: int("OUTBOX_POLL_MS", 500),
    batchSize: int("OUTBOX_BATCH_SIZE", 50),
    leaseMs: int("OUTBOX_LEASE_MS", 30_000),
  },
};

export type Config = typeof config;