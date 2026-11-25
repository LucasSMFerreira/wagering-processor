export const TOKENS = {
  orm: Symbol("orm"),
  sqs: Symbol("sqs"),
  queues: Symbol("queues"),
  processWager: Symbol("processWager"),
  createWallet: Symbol("createWallet"),
  walletQueries: Symbol("walletQueries"),
  reconcileWallet: Symbol("reconcileWallet"),
  workers: Symbol("workers"),
} as const;