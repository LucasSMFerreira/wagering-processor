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
## Autenticação
## Limitações