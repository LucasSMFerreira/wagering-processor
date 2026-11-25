# Teste de carga

Medições feitas no meu homelab, não copiadas de outra máquina.

## Ambiente

- Máquina: <CPU>, <N> núcleos, <RAM> de memória
- Docker Compose com 3 réplicas, PostgreSQL 16, LocalStack 4.14, tudo na mesma máquina
- Comando: `DURATION_S=30 CONCURRENCY=32 WALLETS=50 HOT_WALLET_SHARE=0.2 bun run test:load`

## Metodologia

- 50 wallets com saldo alto; 20% das requisições vão para uma wallet "quente" (a mesma), o resto é aleatório.
- 70% `BET` e 30% `WIN` de 1.00, cada uma com chave nova (sem replay).
- Requisições distribuídas em round-robin entre as 3 instâncias.
- Latência medida no cliente, do envio até o fim da resposta.

## Resultados

| Métrica | Valor |
|---|---|
| Requisições | 4659 |
| Throughput (req/s) | 155,3 |
| p50 / p95 / p99 (ms) | 40,4 / 1087,8 / 1746,2 |
| Taxa de erro | 0% (4659 respostas 201) |
| Conflitos de lock (`wager_lock_conflicts_total`) | 0 |
| Outbox lag ao final (s) | 1,1 (44 eventos pendentes no instante da medição) |

## Análise

A mediana é baixa (40 ms), mas a cauda é longa: o p95 passa de 1 s e o p99 chega a 1,7 s. A diferença vem da carteira quente. Cerca de 20% das requisições (~930) disputam a mesma linha, e cada uma espera a anterior no `SELECT ... FOR UPDATE`, o que limita essa carteira a algo perto de 30 transações por segundo, enquanto as outras 49 seguem em paralelo. O p99 é praticamente a fila dessa carteira.

`wager_lock_conflicts_total` ficou em 0 porque essa métrica conta só timeouts de lock e corridas de constraint única resolvidas com retry. Esperar na fila do lock não é conflito. Ou seja, o sistema serializou corretamente, sem erro, só com espera.

Nenhuma requisição falhou e nenhuma foi recusada: as 4659 voltaram 201, já que as carteiras começam com saldo alto.

O outbox terminou com 1,1 s de atraso e 44 eventos pendentes. Isso é uma foto tirada no último instante do teste, com o publicador ainda alcançando a produção. O outbox é uma tabela compartilhada, então esse número vale para as três instâncias.

O que eu mudaria: para uma carteira muito disputada, particionar a fila por carteira com um consumidor por partição, ou dividir o saldo em sub-contas. Os dois removem a disputa pela mesma linha. Também rodaria o teste com o gerador de carga fora da máquina do serviço, porque aqui cliente, 3 réplicas, Postgres e LocalStack dividem a mesma CPU.