# ARCHITECTURE.md

## Dinheiro
## Concorrência

O ponto de serialização é a linha da carteira no Postgres. Toda operação abre uma transação SQL e faz `SELECT ... FOR UPDATE` na carteira antes de qualquer outra coisa. Duas operações na mesma carteira, vindas da API, da fila ou de outra instância, entram em fila nesse lock e rodam uma de cada vez. Operações em carteiras diferentes seguem em paralelo.

Escolhi lock pessimista no banco, e não lock em memória nem versão otimista, porque funciona com várias instâncias sem nada além do Postgres e não exige retentativa em caso de conflito.

O custo aparece numa carteira muito disputada: a vazão dela fica limitada a uma transação por vez, e as requisições seguintes esperam segurando uma conexão do pool. Por isso a transação é curta: nada de chamada de rede dentro dela. A resposta HTTP e o delete da mensagem no SQS só acontecem depois do commit.

## Idempotência

A fonte de verdade é a tabela `wager_transactions` no Postgres, não a memória nem a fila. A `Idempotency-Key` tem constraint `unique`, e o par `(provider_id, external_transaction_id)` também.

A chave é consultada depois de travar a carteira, então duas cópias da mesma aposta não conseguem passar juntas pela checagem. Se a chave já existe com o mesmo `payload_hash`, devolvo o resultado original sem tocar no saldo. Se existe com hash diferente, é conflito. A constraint `unique` é a última barreira: mesmo que o código erre, o banco recusa a segunda gravação.

O teste prova isso com 50 envios simultâneos da mesma aposta: um débito só.
## Ledger e reconciliação
## Mensageria e outbox

Referências fora de ordem
Um ROLLBACK ou REFUND pode chegar antes da transação que ele referencia, porque a fila tem vários consumidores e o provedor pode mandar o estorno pela API enquanto a BET ainda está na fila. Por isso ele não é recusado na hora. A transação fica em `PENDING_REFERENCE` e o outbox publica `WagerTransactionPendingReference`, avisando o provedor que o estorno foi recebido mas está esperando. Um worker volta a checar com backoff exponencial: 1 s, 2 s, 4 s até 512 s, em 10 tentativas, cerca de 17 minutos no total. Os dois valores ficam no `config.ts` (`PENDING_REFERENCE_MAX_ATTEMPTS` e `PENDING_REFERENCE_BASE_DELAY_MS`). Se a referência aparece nesse intervalo, o estorno é aplicado normalmente e sai `WagerTransactionProcessed`. Se não aparece, a transação vira `REJECTED` com `REFERENCE_NOT_FOUND`, e o evento `WagerTransactionRejected` avisa o provedor. A ação desse código é `fix-payload`: o provedor precisa conferir a referência e reenviar. Esperar para sempre deixaria transações penduradas sem resposta, e recusar na hora puniria o provedor por um problema de transporte.

## Autenticação

O desafio deixa autenticação fora do escopo, mas o ponto de entrada já existe: o `ProviderAuthGuard` (`src/http/auth.guard.ts`). Ele está em todas as rotas de negócio (`/wallets` e `/wagering/...`) e fora das rotas de saúde e métricas (`/health/live`, `/health/ready`, `/metrics`), que precisam responder para o orquestrador sem credencial.

Hoje o guard deixa tudo passar. Em produção, ele faria duas coisas:
1. Validar um token OIDC emitido para cada provedor (assinatura, expiração e audiência).
2. Conferir que o `providerId` do token é o mesmo do corpo da requisição. Sem isso, um provedor autenticado poderia lançar transações em nome de outro.

Como a regra fica toda no guard, ligar a autenticação não muda controller, caso de uso nem domínio.
## Limitações

Todas as rotas seguem a mesma tabela. Um único lugar decide o status (`answerFor`, em `src/http/presenters.ts`), e os controllers nunca escolhem status por conta própria.

| Situação | Status | Ação para o provedor |
|---|---|---|
| Aplicada agora | 201 | — |
| Replay de uma já aplicada | 200 | — |
| Aceita, esperando a referência | 202 | consultar depois ou reenviar com a mesma chave |
| Payload inválido, sem `Idempotency-Key`, cursor inválido | 400 | `fix-payload` |
| Mesma chave com outro payload | 409 | `fix-payload` |
| Rejeição de negócio ou carteira inexistente | 422 | depende do código de falha |
| Banco ou fila fora do ar | 503 com `Retry-After` | `retry-later` |

Rejeição de negócio é 422, e não 400: o pedido estava bem formado, foi o estado da carteira que não permitiu. O replay de uma rejeição continua 422, com o mesmo código.

O corpo sempre traz `balance` e `idempotentReplay`. No replay, `balance` é o saldo da época da decisão, e `idempotentReplay: true` deixa claro que nada novo aconteceu. Erro inesperado vira 500 com o stack só no log, nunca na resposta.

### Ação por código de falha (422)

| Código | Ação |
|---|---|
| `INSUFFICIENT_FUNDS` | `give-up` |
| `REVERSAL_INSUFFICIENT_FUNDS` | `give-up` |
| `REFERENCE_NOT_PROCESSED` | `give-up` |
| `REFERENCE_ALREADY_REVERSED` | `give-up` |
| `CURRENCY_MISMATCH` | `fix-payload` |
| `WALLET_PLAYER_MISMATCH` | `fix-payload` |
| `WALLET_NOT_FOUND` | `fix-payload` |
| `REFERENCE_NOT_FOUND` | `fix-payload` |
| `REFERENCE_MISMATCH` | `fix-payload` |
| `REFERENCE_INVALID_KIND` | `fix-payload` |
| `REVERSAL_AMOUNT_MISMATCH` | `fix-payload` |
| `PROCESSING_FAILED` | `retry-later` |