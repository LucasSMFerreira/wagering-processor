# Wagering Processor

Serviço financeiro que processa transações de aposta (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas por HTTP e por SQS, e continua correto com mensagens duplicadas, fora de ordem, simultâneas e com o processo morrendo no meio.

Stack: Bun 1.x, TypeScript strict, NestJS 11, PostgreSQL 16, MikroORM 6, SQS via LocalStack, Docker Compose.

As decisões e os trade-offs estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Requisitos

- Docker com Compose v2
- Bun 1.x (só para rodar os testes e scripts fora do container)

## Subir tudo

```bash
docker compose up -d --build
```

Sobe PostgreSQL, LocalStack (filas criadas no boot), roda as migrations e inicia **3 réplicas** do serviço nas portas 3000, 3001 e 3002.

```bash
curl localhost:3000/health/ready
```

## Exemplo rápido

```bash
WALLET=$(curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}' | jq -r .id)

curl -s -X POST localhost:3001/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-123\",\"playerId\":\"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1\",\"walletId\":\"$WALLET\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"

curl -s localhost:3002/wallets/$WALLET/ledger
curl -s -X POST localhost:3000/wallets/$WALLET/reconciliation
```

## Testes

Os testes de integração usam o PostgreSQL e o LocalStack do compose (banco separado `wagering_test`, filas com nome aleatório).

```bash
bun install
docker compose up -d postgres localstack
bun test                      # tudo: unidade, integração, concorrência, 3 instâncias
bun run test:unit             # só unidade, sem Docker
bun run test:integration
bun run typecheck
```

## Teste de carga (opcional)

Com o compose no ar:

```bash
DURATION_S=30 CONCURRENCY=32 WALLETS=50 bun run test:load
```

Resultados e metodologia em [docs/load-test.md](docs/load-test.md).

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | sobe uma instância local (precisa de Postgres e LocalStack) |
| `bun run migrate:up` / `migrate:down` | aplica ou reverte as migrations |
| `bun test` | suíte completa |
| `bun run test:load` | teste de carga |

## Variáveis de ambiente

Veja [.env.example](.env.example). Todas têm default para o ambiente local.

## Endpoints

| Método | Rota |
|---|---|
| `POST` | `/wallets` |
| `GET` | `/wallets/:walletId` |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` |
| `POST` | `/wallets/:walletId/reconciliation` |
| `POST` | `/wagering/transactions` (header `Idempotency-Key`) |
| `GET` | `/wagering/transactions/:transactionId` |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` |
| `GET` | `/health/live`, `/health/ready`, `/metrics` |