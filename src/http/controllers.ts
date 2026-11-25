import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { createWalletSchema, wagerTransactionSchema } from "../app/commands";
import type { ProcessWagerTransaction } from "../app/process-wager.use-case";
import type { CreateWallet, ReconcileWallet, WalletQueries } from "../app/wallets.use-cases";
import { ProviderAuthGuard } from "./auth.guard";
import { answerFor, ledgerEntryView, reconciliationView, transactionView, walletView } from "./presenters";
import { TOKENS } from "./tokens";

const uuid = z.string().uuid();
const correlationOf = (header: string | undefined) => ({ correlationId: header || Bun.randomUUIDv7() });

@Controller("wallets")
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(TOKENS.createWallet) private readonly createWallet: CreateWallet,
    @Inject(TOKENS.walletQueries) private readonly queries: WalletQueries,
    @Inject(TOKENS.reconcileWallet) private readonly reconcile: ReconcileWallet,
  ) {}

  @Post()
  async create(@Body() body: unknown, @Headers("x-correlation-id") cid: string | undefined, @Res() res: Response) {
    const input = createWalletSchema.parse(body);
    const result = await this.createWallet.execute(input, correlationOf(cid));
    if (result.kind === "already-exists") {
      res.status(409).json({ error: "WALLET_ALREADY_EXISTS", action: "give-up" });
      return;
    }
    res.status(201).json(walletView(result.wallet));
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string, @Res() res: Response) {
    const wallet = uuid.safeParse(walletId).success ? await this.queries.getWallet(walletId) : undefined;
    if (!wallet) {
      res.status(404).json({ error: "WALLET_NOT_FOUND" });
      return;
    }
    res.json(walletView(wallet));
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limitParam: string | undefined,
    @Res() res: Response,
  ) {
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(limitParam);
    uuid.parse(walletId);
    if (!(await this.queries.getWallet(walletId))) {
      res.status(404).json({ error: "WALLET_NOT_FOUND" });
      return;
    }
    const page = await this.queries.ledger(walletId, cursor, limit);
    res.json({ entries: page.entries.map(ledgerEntryView), nextCursor: page.nextCursor });
  }

  @Post(":walletId/reconciliation")
  async reconciliation(
    @Param("walletId") walletId: string,
    @Headers("x-correlation-id") cid: string | undefined,
    @Res() res: Response,
  ) {
    const report = uuid.safeParse(walletId).success
      ? await this.reconcile.execute(walletId, correlationOf(cid))
      : undefined;
    if (!report) {
      res.status(404).json({ error: "WALLET_NOT_FOUND" });
      return;
    }
    res.json(reconciliationView(report));
  }
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(TOKENS.processWager) private readonly processWager: ProcessWagerTransaction,
    @Inject(TOKENS.walletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-correlation-id") cid: string | undefined,
    @Res() res: Response,
  ) {
    const key = z.string().trim().min(1).max(400).safeParse(idempotencyKey);
    if (!key.success) {
      res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED", action: "fix-payload" });
      return;
    }
    const input = wagerTransactionSchema.parse(body);
    const result = await this.processWager.execute({ ...input, idempotencyKey: key.data }, correlationOf(cid));
    const answer = answerFor(result);
    res.status(answer.status).json(answer.body);
  }

  @Get("wagering/transactions/:transactionId")
  async get(@Param("transactionId") id: string, @Res() res: Response) {
    const tx = uuid.safeParse(id).success ? await this.queries.getTransaction(id) : undefined;
    if (!tx) {
      res.status(404).json({ error: "TRANSACTION_NOT_FOUND" });
      return;
    }
    res.json(transactionView(tx));
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalId: string,
    @Res() res: Response,
  ) {
    const tx = await this.queries.getTransactionByExternalId(providerId, externalId);
    if (!tx) {
      res.status(404).json({ error: "TRANSACTION_NOT_FOUND" });
      return;
    }
    res.json(transactionView(tx));
  }
}