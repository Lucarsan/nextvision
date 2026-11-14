# 06 — Avaliação tecnológica e possíveis migrações (Fase 6)

> Princípio adotado: **evolução incremental**. Uma tecnologia só é trocada quando há um problema concreto,
> demonstrado no código, que a troca resolve melhor do que um ajuste na tecnologia atual.

## 1. Veredito por componente

| Componente | Atual | Decisão | Motivo curto |
|---|---|---|---|
| Linguagem backend | JavaScript (Node ≥ 20, ESM) | **Manter**, adicionar tipagem gradual | O problema é falta de tipos e de estrutura, não a linguagem |
| Framework HTTP | Express 4.22 | **Manter**; migrar para Express 5 quando conveniente | Express 4 está em manutenção, mas estável; o 5 é quase compatível |
| Validação | zod 3 | **Manter** | Bem usada em todas as rotas; base para tipos |
| Acesso a dados | `pg` + SQL manual | **Manter** + helpers e tipagem de resultados | Usa recursos do Postgres que ORMs atrapalham |
| Banco | PostgreSQL (Neon) | **Manter** | Adequado; falta RLS, papéis e índices |
| Frontend | HTML + JS global sem build | **Evoluir**: módulos ES + build leve; framework só depois | Maior fonte de dívida e risco de XSS |
| Hospedagem API | Render (1 serviço) | **Manter**; adicionar staging e cron/worker | Suficiente para a escala atual |
| Vídeo | MediaMTX + Cloudflare Tunnel + Worker | **Manter** | Desenho bom e barato; consolidar no modo borda |
| Agente da loja | PowerShell 5.1 + WinSW | **Manter** | Roda em qualquer Windows sem instalar runtime; já testado no CI |
| E-mail | Resend | **Manter** | Simples, já integrado |
| Testes | `node:test` + Playwright | **Manter**, levar ao CI | Ferramentas certas, falta pipeline |

**Não recomendo reescrita integral.** Nada no código justifica: as regras funcionam, o banco está bem
modelado e o maior custo é organização, não tecnologia.

## 2. Análises de substituição (formato exigido pela spec)

### 2.1 JavaScript → TypeScript (backend e frontend)

| Item | Análise |
|---|---|
| 1. Problema concreto | Nenhuma verificação de tipos: colunas renomeadas, campos opcionais e formatos de JSON (`process_snapshot`, `payments`, `details`) só falham em produção; 239 rotas compartilham formatos sem contrato. |
| 2. Limitação | JS não detecta incompatibilidades entre SQL, rota e frontend; zod cobre só a entrada. |
| 3. Alternativa | TypeScript, começando com `// @ts-check` + JSDoc (zero build), depois `.ts` com `tsx`/`tsc`. Tipos inferidos dos schemas zod (`z.infer`). |
| 4. Benefícios | Refatorações seguras (essencial para quebrar `server.js`/`store-sales.js`); contrato compartilhado front/back; menos regressões. |
| 5. Desvantagens | Etapa de build/checagem; curva para quem mantém; tipos do SQL precisam ser escritos ou gerados. |
| 6. Custo | Médio, diluído (arquivo a arquivo). |
| 7. Riscos | Baixos se gradual; a checagem não muda o comportamento em tempo de execução. |
| 8. Infraestrutura | Nenhum impacto com `@ts-check`; com `.ts`, passo de build no Render. |
| 9. Banco | Nenhum. |
| 10. Migração | `@ts-check` nos módulos novos e nos extraídos → tipos dos schemas zod → `.ts` quando a estrutura estabilizar. |
| 11. Decisão | **Adotar gradualmente (P4)**, depois de CI e modularização. |

### 2.2 Express 4 → Express 5 / Fastify

| Item | Análise |
|---|---|
| Problema | Express 4 está em modo manutenção; não trata promessas rejeitadas (daí o wrapper `route()` em toda rota). |
| Alternativa A | **Express 5**: trata `async` nativamente, mudanças pequenas (sintaxe de rotas com regex, `req.query`). Rotas com regex em `server.js:789,803` precisam de ajuste. |
| Alternativa B | Fastify: mais rápido, schemas nativos, mas reescreveria todas as 239 rotas e middlewares. |
| Benefícios | A: remove `route()`, suporte de longo prazo. B: performance que **hoje não é o gargalo** (os gargalos estão em SQL e polling). |
| Custos/Riscos | A: baixo. B: alto, sem ganho demonstrado. |
| Decisão | **Express 5 em P5**, com testes no CI. **Fastify: não.** |

### 2.3 SQL manual → ORM (Prisma/TypeORM/Sequelize) ou query builder (Kysely/Drizzle)

| Item | Análise |
|---|---|
| Problema | SQL repetido e sem tipos; boilerplate de transação. |
| ORMs completos | Atrapalham advisory locks, `FOR UPDATE OF`, `jsonb`, CTEs e triggers que o sistema usa muito; migrar 59 migrations e ~730 chamadas SQL é caro e arriscado. **Não.** |
| Query builder tipado (Kysely/Drizzle) | Mantém SQL explícito com tipos; pode conviver com `pg` consulta a consulta. |
| Decisão | **Não agora.** Primeiro `withTransaction()` e repositórios simples por domínio (P2). Reavaliar Kysely junto com TypeScript (P5). |

### 2.4 Frontend sem framework → React/Vue/Svelte

| Item | Análise |
|---|---|
| 1. Problema | 316 KB num arquivo, estado global, HTML concatenado (~237 `innerHTML`), helpers duplicados, sem componentes reutilizáveis, polling com re-render completo. |
| 2. Limitação | Sem módulos não há reaproveitamento; sem template seguro, cada campo é um risco de XSS. |
| 3. Alternativas | (a) **módulos ES + helper de template com escape automático (ex.: `lit-html`) + esbuild**; (b) Preact/React; (c) Vue/Svelte. |
| 4. Benefícios | (a) resolve duplicação, XSS e cache com mudança incremental, tela a tela, mantendo o HTML atual. (b)/(c) ecossistema de componentes e estado. |
| 5. Desvantagens | (a) ainda manual para estado complexo. (b)/(c) reescrita das telas, build obrigatório, 35 testes de painel quebram. |
| 6. Custo | (a) médio, distribuído. (b)/(c) alto. |
| 7. Riscos | (a) baixo. (b)/(c) regressões em telas usadas o dia todo (caixa). |
| 8. Infraestrutura | Passo de build no deploy em todos os casos. |
| 9. Banco | Nenhum. |
| 10. Migração | (a) agora; se depois o caixa ainda for complexo demais, migrar **só essa tela** para Preact dentro da estrutura de módulos. |
| 11. Decisão | **(a) em P2/P3; framework só se (a) não bastar.** |

### 2.5 Render → outra hospedagem (Fly.io, Railway, VPS, Cloud Run)

Sem problema concreto demonstrado. O Render atende a escala atual; as limitações vistas (serviço que dorme,
disco efêmero, uma instância) se resolvem com plano pago, Cron Job do Render e estado no banco.
**Manter.** Reavaliar só se custo ou latência (região) virarem problema medido.

### 2.6 Postgres em `bytea` → armazenamento de objetos (R2/S3) para imagens

Ver PERF-04. **Adotar quando** o tamanho do banco ou do backup incomodar (medir no Neon). Cloudflare R2 é
natural porque a conta Cloudflare já existe e não cobra saída de dados. Migração: novas fotos no R2, leitura
com fallback para `bytea`, cópia em segundo plano, remoção depois.

### 2.7 Polling → Server-Sent Events / WebSocket

Polling de 5 s com lista completa é o problema (PERF-02); a correção principal é **incremental + paginada**,
que mantém o polling barato. SSE (P5) só depois, se ainda houver necessidade de latência menor; exige atenção
ao modelo de instância única.

### 2.8 Redis, filas (BullMQ/RabbitMQ), Kafka, microsserviços

**Não recomendados.** Não há gargalo que os exija: os jobs atuais cabem num processo de cron com trava no
Postgres; o rate limit compartilhado pode usar o Postgres. Reavaliar só com várias instâncias **e** medição
mostrando o Postgres como gargalo.

### 2.9 Agente PowerShell → Go/.NET/Node empacotado

PowerShell 5.1 está em todo Windows, o agente já tem testes no CI (`windows-agent.yml`), assinatura de
pacotes e atualizador com rollback. Um binário compilado melhoraria distribuição e desempenho, mas sem
problema concreto que justifique. **Manter**; consolidar as duas gerações (`connect/` × `installer/`).

## 3. Resumo das decisões

| Prioridade | Mudança tecnológica |
|---|---|
| P1 | Nenhuma troca; apenas CI, staging e configuração validada |
| P2 | Build leve do frontend (esbuild) + módulos ES + template seguro |
| P3 | R2 para imagens (se medido); jobs como Cron Job do Render |
| P4 | `@ts-check` → TypeScript gradual |
| P5 | Express 5; avaliar Kysely; avaliar SSE |
