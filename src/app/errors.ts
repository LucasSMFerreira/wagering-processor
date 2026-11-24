import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";

/** Infrastructure is down or busy: the same request may work later. */
export class TransientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransientError";
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof UniqueConstraintViolationException;
}

export function isTransient(error: unknown): boolean {
  if (error instanceof TransientError) return true;
  if (error instanceof ConnectionException || error instanceof DeadlockException) return true;
  if (error instanceof LockWaitTimeoutException) return true;
  const code = (error as { code?: string })?.code;
  return ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "57P01", "57P03", "53300", "40001", "40P01"].includes(code ?? "");
}