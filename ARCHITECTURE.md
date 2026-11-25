# ARCHITECTURE.md

Processador distribuído de transações de aposta. Este documento explica as decisões, os trade-offs e as limitações. O "como rodar" está no `README.md`.

## 1. Visão em uma página

```
POST /wagering/transactions ─┐
                             ├─► ProcessWagerTransaction (um use case) ─► uma transação SQL:
SQS wager-transactions.fifo ─┘        inbox → lock da wallet → idempotência → regras
                                      → wager_transactions + ledger_entries + wallets + outbox_messages
                                                   │ COMMIT
                     ┌─────────────────────────────┴──────────────────────────┐
             resposta HTTP / ack SQS                         OutboxPublisher (N instâncias, SKIP LOCKED)
                                                                   └─► fila wagering-events
                                PendingReferenceWorker ─► reprocessa PENDING_REFERENCE com backoff
```

Camadas:

| Pasta | Conteúdo | Depende de |
|---|---|---|
| `src/domain` | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `settle()`, eventos, inbox/outbox | nada (nem ORM, nem Nest) |
| `src/app` | use cases, workers, consumidor SQS, publisher da outbox | domínio + portas da infra |
| `src/infra` | MikroORM (records, repositório, migrations), cliente SQS | bibliotecas |
| `src/http` | controllers NestJS, mapeamento de status, guard de auth | app |
| `src/observability` | logs JSON e métricas Prometheus | nada |

## 2. Stack e ORM

- **Bun 1.x** como runtime, gerenciador de pacotes e test runner; **TypeScript** em `strict` (com `noUncheckedIndexedAccess`).
- **NestJS 11** só na borda HTTP e no ciclo de vida (start/stop dos workers). O domínio não conhece o Nest.
- **MikroORM 6 (PostgreSQL)**, escolhido por:
  - `em.transactional()` explícito: o limite da transação é visível no código;
  - Unit of Work: inserts e o update da wallet saem juntos no flush, no fim da transação;
  - `LockMode.PESSIMISTIC_WRITE` (`FOR UPDATE`) e `PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`) prontos;
  - `EntitySchema` sem decorators: as entidades de persistência (`records.ts`) são classes simples, e o domínio é reidratado pelos `rehydrate()`.
- Fiz **records separados do domínio** de propósito. O custo é um mapper; o ganho é que nenhum decorator ou tipo do ORM entra no domínio, e a reidratação passa pela factory exigida.
- **Migrations versionadas e reversíveis** (`up`/`down`) escritas em SQL, porque as garantias mais importantes são triggers e índices parciais que o gerador de schema não expressa.

## 3. Dinheiro (`Money`)

- Valor guardado como **centavos em `bigint`**, moeda ISO-4217. Escala fixa de 2: não existe arredondamento, porque entrada com mais de 2 casas é rejeitada.
- Entrada é string que casa com `^-?(0|[1-9]\d*)(\.\d{1,2})?$`. Isso recusa `NaN`, `Infinity`, `1e3`, vazio, `1.234`, `01.00`, `.5`, `+1`.
- `Money.from` (contratos de entrada) recusa negativo; `Money.parse` (dados internos) aceita.
- Saída sempre com 2 casas (`"25.00"`).
- No banco: `numeric(20,2)` + `char(3)` em colunas separadas. O MikroORM devolve `numeric` como string, que vira `Money` sem passar por `number`.
- Uma moeda só (BRL) nos testes de fluxo, mas o modelo é multi-moeda: operações entre moedas diferentes lançam `CurrencyMismatchError`, testado.

## 4. Concorrência

**Estratégia: lock pessimista por wallet** (`SELECT ... FOR UPDATE` na linha da wallet), dentro da transação.

- A unidade de concorrência é a wallet. Wallets diferentes não disputam lock (teste "different wallets are processed in parallel").
- Por que não otimista: wallet quente (muitas apostas na mesma wallet) gera muito retry com lock otimista. O pessimista enfileira no banco, sem retry, e o tempo de lock é curto (poucas queries).
- Por que não só `UPDATE ... WHERE balance >= x`: resolveria o saldo, mas a regra de negócio precisa ler o estado (referência, reversão já feita, idempotência) de forma serializada. O lock dá isso para todas as regras.
- `version` continua existindo e sobe a cada mudança de saldo, para auditoria e para os eventos (`walletVersion`).
- **Defesa em profundidade:** mesmo que o lock falhasse, o banco recusa saldo negativo (`CHECK`), saldo diferente do ledger (constraint trigger) e débito duplicado (`UNIQUE`).
- Ordem de locks: sempre a wallet primeiro. O worker de referências pendentes segue a mesma ordem (wallet, depois a linha da transação com `SKIP LOCKED`), o que evita deadlock entre eles.

Cenário obrigatório (saldo 100, duas apostas de 80 simultâneas): a primeira pega o lock e debita; a segunda espera, lê 20 e é rejeitada com `INSUFFICIENT_FUNDS`. Testado em processo único e em duas instâncias diferentes.

## 5. Idempotência

- `Idempotency-Key` é obrigatória e é a fonte da verdade. Default sugerido: `{providerId}:{externalTransactionId}`.
- `payloadHash` = SHA-256 (hex) do JSON canônico (chaves ordenadas em todos os níveis, sem `undefined`) dos campos de negócio: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId`. O `amount` é normalizado (`"25"` e `"25.00"` são a mesma requisição). Header e metadados de transporte ficam fora.
- Mesma chave + mesmo hash: devolve a transação original, com o `balanceAfter` daquele momento (`idempotentReplay: true`).
- Mesma chave + hash diferente: `409`, nunca replay.
- Mesmo `(providerId, externalTransactionId)` com outra chave: também `409` (decisão minha: o id do provedor identifica a operação, duas chaves para ela seriam erro do provedor).
- Garantia no banco: `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`. Duas requisições iguais em instâncias diferentes: o lock da wallet as serializa; se a chave apontar para wallets diferentes, a segunda bate no `UNIQUE`, o use case tenta de novo (até 3 vezes) e na segunda volta encontra a original.
- Nada de idempotência em memória.

## 6. Ledger e reconciliação

- `ledger_entries` é append-only: trigger recusa `UPDATE` e `DELETE`.
- `CHECK` garante `balance_after = balance_before ± amount`.
- Trigger de cadeia: cada lançamento começa onde o anterior da mesma wallet terminou.
- **Constraint trigger adiada** (`deferrable initially deferred`) em `wallets`: no commit, o saldo da wallet tem de ser igual ao `balance_after` do último lançamento. "Toda alteração de saldo tem lançamento e vice-versa" fica garantido pelo banco.
- `UNIQUE (transaction_id, wallet_id)`: no máximo um lançamento por transação por wallet.
- Saldo inicial maior que zero vira uma transação interna `OPENING` com um `CREDIT`, na mesma transação SQL. A wallet nasce em `version = 1`.
- `POST /wallets/:id/reconciliation` recalcula o saldo pelo ledger num snapshot `REPEATABLE READ`. Divergência não é corrigida: vai para log (`error`), métrica (`wager_reconciliation_mismatches_total`) e para a resposta (`consistent: false`).
- Partidas dobradas não foram implementadas (opcional).

## 7. Estados da `WagerTransaction`

```
            ┌──────────────► PROCESSED   (terminal)
PENDING ────┼──────────────► REJECTED    (terminal)
   │        └──────────────► FAILED      (terminal)
   └──► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
              │  ▲
              └──┘ nova tentativa (attempts + 1, novo next_reference_check_at)
```

- Estados terminais não mudam: o domínio lança `InvalidTransactionStateError` e um trigger no banco recusa o `UPDATE`.
- Na prática `PENDING` só existe em memória: a decisão acontece na mesma transação SQL em que a linha é gravada.
- `FAILED` está modelado e pronto para "erro permanente de infraestrutura", mas nenhum fluxo atual o usa: falhas de infraestrutura acontecem antes do commit, então nada é gravado e o provedor reenvia (HTTP `503`) ou a fila redelivera.

## 8. Regras de negócio e interpretações

As regras da seção 7 do desafio estão em `src/domain/settlement.ts`, uma função pura testada sem banco. Interpretações que adotei:

1. **Uma reversão por referência, qualquer que seja o tipo.** O enunciado diz "pelo mesmo tipo de operação"; lido ao pé da letra, uma `BET` poderia receber `REFUND` e depois `ROLLBACK`, creditando duas vezes. Bloqueio isso com o índice único parcial `wager_tx_one_reversal_per_reference`. Uma `REFUND` pode ser desfeita por um `ROLLBACK` (referência diferente).
2. `WIN` com `referenceExternalTransactionId` valida a referência (mesmo provider, player, wallet, moeda e rodada, e precisa ser `BET`). Sem referência, o `WIN` é aceito.
3. Qualquer transação que aponta para uma referência ainda inexistente vira `PENDING_REFERENCE`, inclusive `WIN`.
4. `LOSS` não exige `BET` anterior e aceita valor zero.
5. Referência que existe mas não foi `PROCESSED` (foi rejeitada): `REFERENCE_NOT_PROCESSED`.
6. Wallet inexistente: `422 WALLET_NOT_FOUND`, sem gravar nada (não há wallet para pendurar a linha).
7. Wallet de outro player: rejeição gravada `WALLET_PLAYER_MISMATCH`.
8. Referência que expirou como `REJECTED` e cuja `BET` chega depois: a `BET` é processada normalmente. É uma limitação conhecida; o provedor recebeu `WagerTransactionRejected` com `REFERENCE_NOT_FOUND` e pode reagir.

## 9. Referências fora de ordem

- Worker agendado (`PendingReferenceWorker`), em todas as instâncias. Cada linha é pega com `FOR UPDATE SKIP LOCKED`.
- Backoff exponencial: 1 s, 2 s, 4 s ... 512 s, até **10 tentativas** (cerca de 17 minutos no total).
- Por que esse limite: provedores costumam reenviar a operação original em segundos ou poucos minutos; esperar mais deixa um estorno pendurado sem resposta. Configurável por `PENDING_REFERENCE_MAX_ATTEMPTS`.
- Esgotado: `REJECTED` com `REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected`. Na primeira vez que fica pendente sai `WagerTransactionPendingReference`.

## 10. Códigos de falha

Cada código traz uma ação para o provedor (`action` na resposta):

| Código | Quando | Ação |
|---|---|---|
| `INSUFFICIENT_FUNDS` | aposta maior que o saldo | `give-up` |
| `REVERSAL_INSUFFICIENT_FUNDS` | reversão deixaria saldo negativo (ex.: `ROLLBACK` de `WIN` já gasto) | `give-up` |
| `CURRENCY_MISMATCH` | moeda da operação diferente da wallet | `fix-payload` |
| `WALLET_PLAYER_MISMATCH` | wallet não pertence ao player | `fix-payload` |
| `WALLET_NOT_FOUND` | wallet não existe (não gravado) | `fix-payload` |
| `REFERENCE_NOT_FOUND` | referência não chegou no prazo | `fix-payload` |
| `REFERENCE_MISMATCH` | referência de outro provider, player, wallet, moeda ou rodada | `fix-payload` |
| `REFERENCE_INVALID_KIND` | `REFUND` fora de `BET`, `ROLLBACK` de `LOSS`, `WIN` fora de `BET` | `fix-payload` |
| `REFERENCE_NOT_PROCESSED` | referência foi rejeitada | `give-up` |
| `REFERENCE_ALREADY_REVERSED` | referência já revertida | `give-up` |
| `REVERSAL_AMOUNT_MISMATCH` | valor diferente da referência | `fix-payload` |
| `PROCESSING_FAILED` | reservado para `FAILED` | `retry-later` |

## 11. HTTP

| Situação | Status |
|---|---|
| aplicada agora | `201` |
| replay de uma aplicada | `200` com `idempotentReplay: true` |
| aceita, aguardando referência | `202` |
| payload inválido, sem `Idempotency-Key`, cursor inválido | `400` |
| conflito de idempotência, wallet duplicada | `409` |
| rejeição de negócio (gravada) ou wallet inexistente | `422` com `failureCode` |
| falha transitória (banco fora, deadlock) | `503` com `Retry-After` |

O replay de uma rejeição devolve `422` de novo, com `idempotentReplay: true`: o código depende do resultado, não de ser replay. Cursor do ledger: `seq` (bigserial) codificado em base64url, paginação por keyset, estável enquanto chegam lançamentos novos.

## 12. SQS

- Fila `wager-transactions.fifo` com redrive para `wager-transactions-dlq.fifo` (`maxReceiveCount = 5`). `MessageGroupId` recomendado: `walletId` (ordem por wallet, paralelismo entre wallets). O consumidor mantém a ordem dentro de um grupo e processa grupos em paralelo.
- Mesmo use case do HTTP. Dedup pela tabela `inbox_messages`, chave `(consumer_name, message_id)`, inserida com `ON CONFLICT DO NOTHING` dentro da mesma transação SQL.
- `ack` (DeleteMessage) só depois do commit.
- Erros:
  - negócio (processada, rejeitada, conflito, duplicada, wallet inexistente): terminal, `ack`;
  - transitório: sem `ack`, visibilidade com backoff (2, 4, 8 s ... até 5 min). Depois de `maxReceiveCount` recebimentos o SQS move para a DLQ;
  - permanente (JSON inválido, envelope ou payload inválido, `OPENING`): enviado direto para a DLQ e `ack`.
- SIGTERM: para de receber, termina as mensagens em mãos; se passar do prazo (10 s), devolve a visibilidade (`VisibilityTimeout = 0`).
- O FIFO do SQS é otimização. A garantia é o banco: os testes enviam a mesma mensagem duas vezes com ids de deduplicação diferentes.

## 13. Outbox

- `outbox_messages` é gravada na mesma transação SQL da mudança financeira. Nada é publicado antes do commit.
- `OutboxPublisher` roda em todas as instâncias. Cada uma reivindica um lote com `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`, gravando um lease (`locked_until`, 30 s). Publica em lotes de 10 (`SendMessageBatch`) e marca `published_at`.
- Morreu depois do commit e antes de publicar: o lease expira e outra instância publica (testado).
- Morreu depois de publicar e antes de marcar: o evento sai de novo. É at-least-once; o envelope carrega `eventId` e o consumidor deduplica por ele (testado que a duplicata tem o mesmo `eventId`).
- Falha de envio: `attempts + 1` e `next_attempt_at` com backoff exponencial (1 s até 5 min).
- Destino: fila `wagering-events` (o desafio não define). Em produção seria um tópico SNS com assinantes.
- Eventos: `WagerTransactionProcessed` (inclusive `LOSS`), `WagerTransactionRejected`, `WalletBalanceChanged` (só quando o saldo muda, inclusive a abertura) e `WagerTransactionPendingReference`. Cada um é uma subclasse de `IntegrationEvent` com `eventType` e `version` no tipo.

## 14. Observabilidade

- Logs JSON, uma linha por evento, com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `instance`. O logger descarta chaves como `money`, `amount`, `balance`, `payload`.
- `GET /metrics` (Prometheus): `wager_transactions_total{kind,status,source}`, `wager_duplicates_total{type}`, `wager_retries_total{component}`, `wager_dlq_messages_total{reason}`, `wager_lock_conflicts_total`, `wager_outbox_lag_seconds`, `wager_outbox_pending`, `wager_reconciliation_mismatches_total`, `wager_processing_seconds` (histograma).
- `GET /health/live` só diz que o processo responde. `GET /health/ready` testa PostgreSQL e SQS (timeout de 2 s).

## 15. Autenticação

Não implementada, por decisão de escopo: não pontua e competiria com o núcleo financeiro.

O ponto de extensão existe: `ProviderAuthGuard` (no-op) está em todos os controllers, menos health e metrics. O desenho que eu adotaria:

1. IdP externo (Keycloak no compose) com um client por provedor, fluxo **client credentials** (máquina para máquina).
2. O guard valida o JWT (assinatura via JWKS, `iss`, `aud`, `exp`) e lê o `provider_id` de um claim.
3. Regra de domínio: o `providerId` do corpo precisa ser igual ao do token, senão `403`.
4. Mensagens da fila são canal interno confiável, mas o `providerId` delas passa pelas mesmas validações de domínio.

## 16. Testes

| Tipo | Onde | O que prova |
|---|---|---|
| Unidade | `test/unit` | `Money`, `Wallet`, ledger, todas as regras de `settle()`, estados, eventos, hash |
| Integração | `test/integration/schema` | cada constraint e trigger recusando escrita inválida |
| Integração | `process-wager`, `pending-reference` | atomicidade, replay, conflito, referências fora de ordem |
| Concorrência | `concurrency` | 50 iguais em paralelo, 100/80+80, hot wallet, wallets em paralelo |
| Mensageria | `messaging` | inbox, redelivery, morte depois do commit e antes do ack, DLQ, SIGTERM, dois publishers, morte antes de publicar |
| Instâncias | `api`, `instances` | API real; 3 processos ao mesmo tempo; SIGKILL no meio do tráfego e reinício |

Todos os testes de integração usam PostgreSQL e LocalStack reais. A invariante `wallet.balance == saldo reconstruído pelo ledger` é checada ao final dos cenários.

## 17. Limitações conhecidas

- Sem autenticação (seção 15).
- `FAILED` modelado, sem fluxo que o produza.
- Lock pessimista limita o throughput de uma única wallet muito quente ao tempo de uma transação; wallets diferentes escalam.
- Inbox e outbox crescem para sempre; produção precisa de limpeza (ex.: apagar outbox publicada há mais de 7 dias, particionar por data).
- Uma referência que expira e chega depois gera uma situação que o provedor precisa resolver (seção 8, item 8).
- O teste de carga roda numa máquina só; números não representam produção.
