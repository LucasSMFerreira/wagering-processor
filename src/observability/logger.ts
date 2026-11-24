import { config } from "../config";

type Level = "debug" | "info" | "warn" | "error";

/** Fields allowed in logs. Amounts and full payloads never go here. */
export interface LogContext {
  correlationId?: string | undefined;
  messageId?: string | undefined;
  transactionId?: string | undefined;
  walletId?: string | undefined;
  providerId?: string | undefined;
  [key: string]: unknown;
}

const FORBIDDEN = new Set(["money", "amount", "balance", "payload", "data", "body"]);
const silent = process.env.LOG_LEVEL === "silent";

function write(level: Level, msg: string, ctx: LogContext = {}): void {
  if (silent) return;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (value !== undefined && !FORBIDDEN.has(key)) safe[key] = value;
  }
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, instance: config.instanceId, ...safe });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
}

/** One JSON object per line. */
export const log = {
  debug: (msg: string, ctx?: LogContext) => write("debug", msg, ctx),
  info: (msg: string, ctx?: LogContext) => write("info", msg, ctx),
  warn: (msg: string, ctx?: LogContext) => write("warn", msg, ctx),
  error: (msg: string, ctx?: LogContext) => write("error", msg, ctx),
};