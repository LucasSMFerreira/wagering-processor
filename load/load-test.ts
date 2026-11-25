/**
 * Load test: bun run test:load
 * Env: TARGETS (comma-separated base URLs), DURATION_S, CONCURRENCY, WALLETS, HOT_WALLET_SHARE
 */
const targets = (process.env.TARGETS ?? "http://localhost:3000,http://localhost:3001,http://localhost:3002").split(",");
const durationS = Number(process.env.DURATION_S ?? 30);
const concurrency = Number(process.env.CONCURRENCY ?? 32);
const walletCount = Number(process.env.WALLETS ?? 50);
const hotShare = Number(process.env.HOT_WALLET_SHARE ?? 0.2);

type Wallet = { id: string; playerId: string };

async function createWallet(i: number): Promise<Wallet> {
  const playerId = crypto.randomUUID();
  const res = await fetch(`${targets[i % targets.length]}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId, initialBalance: { amount: "100000.00", currency: "BRL" } }),
  });
  return { id: ((await res.json()) as { id: string }).id, playerId };
}

const wallets = await Promise.all(Array.from({ length: walletCount }, (_, i) => createWallet(i)));
const latencies: number[] = [];
const statuses = new Map<number, number>();
let sent = 0;
const deadline = Date.now() + durationS * 1000;

async function worker(n: number) {
  while (Date.now() < deadline) {
    const wallet = Math.random() < hotShare ? wallets[0]! : wallets[Math.floor(Math.random() * wallets.length)]!;
    const externalTransactionId = crypto.randomUUID();
    const kind = Math.random() < 0.7 ? "BET" : "WIN";
    const body = {
      providerId: "load",
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${n}`,
      gameId: "load-test",
      kind,
      money: { amount: "1.00", currency: "BRL" },
    };
    const started = performance.now();
    try {
      const res = await fetch(`${targets[sent++ % targets.length]}/wagering/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": `load:${externalTransactionId}` },
        body: JSON.stringify(body),
      });
      await res.arrayBuffer();
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
    } catch {
      statuses.set(0, (statuses.get(0) ?? 0) + 1);
    }
    latencies.push(performance.now() - started);
  }
}

await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]!.toFixed(1);
const total = latencies.length;
const ok = (statuses.get(201) ?? 0) + (statuses.get(422) ?? 0);
const metricsText = await (await fetch(`${targets[0]}/metrics`)).text();
const metric = (name: string) => metricsText.match(new RegExp(`^${name}(?:\\{[^}]*\\})? (\\S+)$`, "m"))?.[1] ?? "n/a";

console.log(
  JSON.stringify(
    {
      environment: { targets: targets.length, concurrency, wallets: walletCount, hotWalletShare: hotShare, durationS },
      requests: total,
      throughputRps: Number((total / durationS).toFixed(1)),
      latencyMs: { p50: pct(50), p95: pct(95), p99: pct(99) },
      statuses: Object.fromEntries(statuses),
      errorRate: Number(((total - ok) / total).toFixed(4)),
      instance0: {
        lockConflicts: metric("wager_lock_conflicts_total"),
        outboxLagSeconds: metric("wager_outbox_lag_seconds"),
        outboxPending: metric("wager_outbox_pending"),
      },
    },
    null,
    2,
  ),
);