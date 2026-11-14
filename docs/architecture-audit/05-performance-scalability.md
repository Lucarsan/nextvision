# 05 — Performance, otimização e escalabilidade (Fase 4)

> Análise estática. Nenhuma medição em produção foi feita: os volumes reais (pedidos por loja, linhas em
> `audit_events`, lojas ativas, painéis abertos) precisam ser confirmados com `EXPLAIN ANALYZE` num **clone**
> do banco ou com as métricas do Neon/Render. Gargalo **comprovado** = o código garante custo crescente;
> **provável** = depende do volume.

## 1. Resumo

| ID | Gargalo | Tipo | Cresce com | Prioridade |
|---|---|---|---|---|
| PERF-01 | Página pública do pedido faz varredura em `audit_events` a cada atualização | comprovado | total de eventos de auditoria de **todas** as lojas | P1 |
| PERF-02 | Painel da loja baixa **todos** os pedidos (histórico inteiro) a cada 5 s | comprovado | pedidos da loja × painéis abertos | P1 |
| PERF-03 | Laço de demonstração consulta o banco a cada 4 s, 24 h por dia | comprovado | tempo (custo fixo) | P2 |
| PERF-04 | Fotos e logos em `bytea` servidos pela API | provável | fotos × acessos | P3 |
| PERF-05 | Backup monta a loja inteira em memória (com fotos) | comprovado | dados da loja | P2 |
| PERF-06 | Proxy HLS legado passa o vídeo pelo Render | comprovado (quando ativo) | espectadores × bitrate | P2 |
| PERF-07 | Listas sem paginação (`/api/customers`, `/api/orders`, produtos) | comprovado | cadastro da loja | P2 |
| PERF-08 | Frontend sem minificação/compressão explícita; 316 KB num arquivo | comprovado | — | P3 |
| PERF-09 | Estado em memória e timers no processo web impedem mais de uma instância | comprovado | — | P3 |
| PERF-10 | Pool de 10 conexões e consultas pesadas no mesmo processo | provável | carga simultânea | P3 |

**Não há evidência que justifique Redis, filas externas, Kafka ou microsserviços hoje.** Os ganhos maiores
vêm de índices, paginação, cálculo incremental e de tirar os timers do processo web.

## 2. Detalhamento

### PERF-01 — Varredura de `audit_events` em toda leitura pública do pedido
- **Evidência**: `server.js:749` calcula `last_change` com
  `SELECT max(a.created_at) FROM audit_events a WHERE a.target_type='order' AND a.target_id=o.id::text`.
  O valor só é usado no modo demo (`server.js:776-781`), mas é calculado **sempre**. O mesmo trecho está em
  `demo-mode.js:76`. Nenhuma migration cria índice em `audit_events(target_type, target_id)` (só PK).
- **Frequência**: `tracking.html:311` recarrega a cada ~15 s por cliente com a página aberta; o `demoTick` roda a cada 4 s.
- **Efeito**: cada carregamento percorre a tabela inteira de auditoria, que cresce com toda ação de todas as lojas. É o gargalo com pior curva de crescimento do sistema.
- **Correção**: (1) índice `CREATE INDEX CONCURRENTLY … ON audit_events(target_id, created_at DESC) WHERE target_type='order'`; (2) calcular `last_change` só quando `t.demo_mode`; (3) a médio prazo, coluna `orders.updated_at` mantida pela própria transição.
- **Risco da correção**: baixo (índice criado com `CONCURRENTLY` fora da transação de migração — o `migrate.js` atual roda tudo numa transação, então precisa de um passo à parte).

### PERF-02 — Polling do painel com a lista completa
- **Evidência**: `store.js:610` chama `reload()` a cada 5 s, que busca `/api/orders` e `/api/processes` (`store.js:314`). `GET /api/orders` (`server.js:434`) devolve **todos** os pedidos não excluídos da loja, desde sempre, com 9 subconsultas por linha (fotos ×2, visitas ×2, eventos ×2, `pending_sales`, `json_agg`).
- **Efeito**: custo ∝ (pedidos acumulados) × (abas abertas) × 12 por minuto. Uma loja com 5.000 pedidos e 3 abas executa ~180 mil subconsultas por minuto, transferindo megabytes repetidos.
- **Correção**: filtrar por estado (fila/andamento/pausados + concluídos das últimas 24–48 h) e paginar o histórico; devolver só o que mudou desde a última versão (`updated_at > $since`) ou um `ETag`; aumentar o intervalo quando a aba não está em foco (já pausa quando oculta); a médio prazo, Server-Sent Events.

### PERF-03 — Timers permanentes no processo web
- **Evidência**: `startDemoLoop` (4 s), `startAutoCloseLoop` (60 s), agendador de relatórios (5 min), limpeza de fotos (6 h) — `server.js:579,811`, `reports.js:295`.
- **Efeito**: a consulta de 4 s roda mesmo sem nenhuma loja em demo. **[HIPÓTESE]** No Neon, atividade constante impede o "scale to zero" e aumenta o custo de computação; no Render, timers param quando o serviço dorme (por isso o cron externo).
- **Correção**: executar a demo só se existir loja em demo (consulta barata + cache) ou disparar sob demanda; mover jobs para um processo/cron dedicado (Render Cron Job ou worker) com trava no banco.

### PERF-04 — Imagens no banco
- **Evidência**: `tenant_logos.image_data` e `order_photos.image_data` (`bytea`), servidos por `server.js:328-346,570-576`; até 9 fotos de 300 KB por pedido.
- **Efeito**: aumenta tamanho do banco, de backups e da memória do processo; cada visualização passa por Node + Postgres. O cache `private, max-age=3600` ajuda.
- **Correção** (quando o volume justificar): armazenamento de objetos (Cloudflare R2, já há conta Cloudflare) com URL assinada; manter `bytea` até lá.

### PERF-05 — Backup em memória
- **Evidência**: `store-backup.js:65-77` agrega todas as linhas de todas as tabelas da loja em JSON (inclui `bytea` como texto hex, que dobra o tamanho), comprime e cifra em memória.
- **Efeito**: lojas com muitas fotos podem estourar a memória da instância do Render, derrubando a API para **todas** as lojas durante o backup.
- **Correção**: excluir fotos do backup (ou parte separada), gerar por tabela em streaming, limitar a uma geração simultânea.

### PERF-06 — Vídeo pelo Render (modo proxy)
- **Evidência**: `server.js:619-679` busca cada segmento HLS e repassa (até 8 MB). O modo borda (Worker) já existe e é escolhido por loja (`EDGE_VIDEO_TENANTS`).
- **Efeito**: banda e conexões do Render proporcionais aos espectadores; latência maior.
- **Correção**: ligar a borda para todas as lojas (`EDGE_VIDEO_TENANTS=all`) depois de validar; manter o proxy só como contingência.

### PERF-07 — Listas sem paginação
`/api/customers` (`server.js:374`, com `json_agg` dos pets por cliente), `/api/orders`, `/api/store/products`
(sugestões limitadas a 200/15, mas a lista principal não), histórico de clientes. Correção: paginação por
cursor e busca no servidor.

### PERF-08 — Entrega do frontend
- Scripts sem minificação; `loja.html` carrega 8 arquivos (~520 KB não comprimidos). Compressão depende do Render/Cloudflare (o app não usa `compression`) — **validar** se há gzip/brotli na borda.
- `express.static` sem `maxAge`: o navegador revalida a cada carregamento (o `?v=N` permitiria cache longo e imutável).
- Imagens do site já em WebP; vídeos de demo em MP4 servidos pelo Node.
- **Correção**: build simples (esbuild) com minificação e hash no nome; `Cache-Control: public, max-age=31536000, immutable` para arquivos com hash; vídeos de demo num CDN/R2.

### PERF-09 — Escala horizontal bloqueada
Caches e contadores em memória (rate limit, `partners.js`, `agent-releases.js`, `store-admin.js:66`,
status do Worker em `edge-video.js`) e timers no processo web. Duas instâncias funcionariam, mas com limites
duplicados e jobs repetidos. Correção: estado compartilhado no Postgres (já disponível) e jobs num único
processo. **Escala vertical** é suficiente até que as correções 01/02 sejam feitas.

### PERF-10 — Conexões com o banco
`db.js`: `max: 10`. Requisições de vídeo (proxy) seguram a requisição HTTP mas não a conexão; consultas
pesadas (01, 02, analytics da central) sim. Com Neon, usar o endpoint com **pooler** (PgBouncer) e medir a
espera por conexão antes de aumentar o pool.

## 3. Índices

**Existentes**: 72, cobrindo bem `tenant_id` + data nas tabelas principais, `share_code`, `public_token_hash`
(UNIQUE), `credential_hash`, fila de pedidos, gravações, cashback, estoque.

**Faltando ou a verificar com `EXPLAIN`**:

| Consulta | Índice sugerido | Evidência |
|---|---|---|
| `audit_events` por pedido | `(target_id, created_at DESC) WHERE target_type='order'` | PERF-01 |
| login por `lower(email)` | `UNIQUE (lower(email))` (hoje o UNIQUE é em `email`) | `server.js:43` |
| `orders` por cliente | `(tenant_id, customer_id, created_at DESC)` | `store-qr.js:69`, exclusão de cliente `server.js:386`, histórico |
| `pending_sales` por pedido/cliente | `(tenant_id, order_id)`, `(tenant_id, customer_id) WHERE paid_sale_id IS NULL AND canceled_at IS NULL` | subconsulta por linha em `GET /api/orders` |
| `recordings` por status (agente) | já há `(tenant_id, camera_id, status)` — ok | `server.js:97-102` |
| `orders` vivos por câmera | `(tenant_id, status) WHERE deleted_at IS NULL` | checagem de câmera ocupada `server.js:527,609` |

## 4. Concorrência e consistência

Bem resolvidas: `FOR UPDATE` nas transições, advisory locks por câmera, por loja (fila, vendas, preços),
por migração e por número do pedido; concorrência otimista com 409. Pontos de atenção:
- `pg_advisory_lock` de sessão em `store-media.js:42-50` (não de transação) mantido durante chamadas HTTP à Cloudflare: segura uma conexão do pool por até ~15 s × chamadas.
- `nv_assign_order_number` sorteia com até 200 tentativas sob trava: com o espaço de 4 dígitos ocupado, cada pedido novo fica mais lento — e o mesmo espaço pequeno é a causa de SEC-02.

## 5. Observabilidade

Sem métricas de aplicação, sem tempo de resposta por rota, sem log de consultas lentas, sem rastreamento.
Mínimo recomendado: log estruturado com duração por requisição; `pg_stat_statements` no Neon; alerta de
latência e de erros 5xx no Render; painel com as 10 consultas mais caras.

## 6. Plano de escalabilidade (sem novas tecnologias)

1. Índice e cálculo condicional (PERF-01) — maior ganho, risco mínimo.
2. Painel incremental e paginado (PERF-02).
3. Jobs fora do processo web (PERF-03, PERF-09).
4. Vídeo 100% pela borda (PERF-06).
5. Backup em streaming e sem fotos (PERF-05).
6. Só então avaliar: segunda instância do Render, R2 para imagens, SSE no painel.
