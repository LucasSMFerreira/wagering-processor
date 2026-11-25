import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";
import { isTransient } from "../app/errors";
import { InvalidCursorError } from "../app/wallets.use-cases";
import { DomainError } from "../domain/errors";
import { log } from "../observability/logger";

/** Maps every thrown error to the same small set of answers. */
@Catch()
export class HttpErrorsFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (error instanceof ZodError) {
      res.status(400).json({
        error: "INVALID_PAYLOAD",
        action: "fix-payload",
        issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    if (error instanceof InvalidCursorError) {
      res.status(400).json({ error: "INVALID_CURSOR", action: "fix-payload" });
      return;
    }
    if (error instanceof DomainError) {
      res.status(400).json({ error: error.code, message: error.message, action: "fix-payload" });
      return;
    }
    if (error instanceof HttpException) {
      res.status(error.getStatus()).json({ error: error.name, message: error.message });
      return;
    }
    if (isTransient(error)) {
      log.warn("transient failure", { error: String(error) });
      res.status(503).setHeader("Retry-After", "1").json({ error: "TEMPORARILY_UNAVAILABLE", action: "retry-later" });
      return;
    }
    log.error("unexpected error", { error: String(error), stack: (error as Error)?.stack });
    res.status(500).json({ error: "INTERNAL_ERROR", action: "retry-later" });
  }
}