# 09 — Análise arquivo por arquivo

> Rastreabilidade exigida pela spec (seção 5). Dependências obtidas por análise dos `import` (script em
> `E:\projetos\_audit-tmp\deps.mjs`, fora do repositório). Referências de achados: `SEC-*` (03), `PERF-*` (05),
> `QLD-*`/`ARQ-*` (04/02), atividades `P*-*` (08).
> **Nível de leitura** de cada arquivo: ver `progress.md`.
>
> **Observação estrutural**: há **dependências circulares** entre `loyalty-rules.js` ↔ `store-sales.js` e
> `reports.js` ↔ `link-analytics.js`. Funcionam hoje por usarem só funções em tempo de execução, mas quebram
> com facilidade numa refatoração (QLD-06).

## 1. Backend (`src/`)

| Arquivo | Responsabilidade | Dependências | Dependentes | Problemas | Segurança | Arquitetura | Refatoração | Prior. | Justificativa |
|---|---|---|---|---|---|---|---|---|---|
| `src/start.js` | entrada de produção: migra, bootstrap, importa o servidor | `migrate.js`, `bootstrap.js` (processos), `server.js` | `npm start` | migração implícita no boot | SEC-03 | boot com efeitos | P0-04: migração como passo de deploy | P0 | dados reais alterados ao iniciar |
| `src/server.js` | app Express, auth, 92 rotas, proxy HLS, timers, erros | 18 módulos locais; express, helmet, rate-limit, jwt, bcrypt, zod | `start.js` | 96 KB, 121 linhas > 200 caracteres, regra do pedido duplicada | SEC-01/02/03/04/05/15/17/23 | "deus", sem camadas | P0-05/06, P1-01/02/03/08/09, P2-02 | P0 | concentra os riscos altos |
| `src/db.js` | pool `pg` (10, TLS verificado) e `q()` | pg | 5 módulos | sem `withTransaction` | TLS ok | ok | P2-01 | P2 | base do boilerplate de transação |
| `src/migrate.js` | aplica migrations em transação com advisory lock | `db.js` | `start.js`, `npm run db:migrate` | lista manual; não suporta `CONCURRENTLY` | usa o mesmo usuário da app (SEC-11) | ok | runner por descoberta + passo fora de transação | P1 | necessário para P1-01 |
| `src/bootstrap.js` | cria o primeiro master | `db.js`, bcryptjs | `start.js` | — | senha ≥ 16 obrigatória (bom) | ok | — | P4 | — |
| `src/store-profile.js` | perfis de nicho | — | `server.js` | — | — | ok | mover para `modules/store-settings` | P4 | — |
| `src/store-sales.js` | caixa, vendas, produtos, estoque, serviços, a receber, cashback, mensagens | `stock-value`, `store-admin`, `store-performance`, `loyalty-rules` | `server.js`, `loyalty-rules` (circular) | 131 KB, 60 rotas, `createSale` ~180 linhas | isolamento por loja **correto** nas rotas revisadas | monolítico | P2-03 | P2 | maior arquivo do backend |
| `src/store-admin.js` | senha admin global, preços em lote/época | bcrypt, jwt, zod | `store-sales`, `reports`, `store-performance` | `lastSync` em memória | SEC-06, SEC-07 | ok | P2-06 | P2 | segredo compartilhado entre lojas |
| `src/stock-value.js` | valor do estoque (com senha admin) | bcrypt, zod | `store-sales` | — | SEC-06 | ok | junto com P2-06 | P2 | — |
| `src/store-performance.js` | metas e comissões | `store-admin` | `store-sales` | — | — | ok | mover para `modules/sales` | P4 | — |
| `src/loyalty-rules.js` | regras de fidelidade | `store-sales` (circular) | `server`, `auto-close`, `store-sales` | circularidade | — | — | mover para `modules/loyalty` | P2 | — |
| `src/store-media.js` | túnel/DNS por loja, provisionamento, heartbeat | `cloudflare`, `secret-box`, `agent-releases` | `server.js` | lock de sessão durante chamadas HTTP | entrega senha MediaMTX e token do túnel ao PC (só com `deviceAuth`, ok) | integração dentro da rota | `adapters/cloudflare` + `modules/devices` | P2 | — |
| `src/cloudflare.js` | cliente da API Cloudflare | — | `edge-video`, `store-media` | — | SEC-12 (escopo do token) | já é adaptador | manter | P3 | — |
| `src/edge-video.js` | tokens da borda; publica o Worker no boot | `cloudflare` | `server.js` | efeito no boot | SEC-03, SEC-20 | ok | P0-04 (flag de publicação) | P0 | publica na produção ao iniciar |
| `src/secret-box.js` | AES-256-GCM para segredos | node:crypto | `store-media` | chave derivada do JWT | SEC-07 | ok | P1-05 (versão de chave) | P1 | — |
| `src/store-backup.js` | backup cifrado por loja; inspeção/exportação/restauração | crypto, zlib, express | `server.js` | tudo em memória; todas as tabelas | SEC-08, SEC-21, PERF-05 | ok | P1-07 | P1 | dados sensíveis e risco de memória |
| `src/agent-releases.js` | pacotes assinados do agente, pedido de atualização | fs, crypto | `server`, `store-media` | lê diretório fora do Git | SEC-24 | ok | P0-07 (validar origem) | P3 | — |
| `src/store-qr.js` | página `/<loja>/oi`, contato, "meus pedidos", QR | qrcode, rate-limit | `server.js` | — | SEC-18 | ok | `modules/customers` | P3 | — |
| `src/link-analytics.js` | visitas/eventos dos links; analytics da central | `reports` (circular) | `server`, `reports` | circularidade; 29 KB | analytics de visitante (SEC-10) | ok | `modules/central` | P3 | — |
| `src/reports.js` | relatórios por e-mail, agendador, cron | `link-analytics`, `store-admin` | `server`, `link-analytics` | timers no registro | SEC-16 | efeito ao registrar | P1-09, P3-01 | P1 | endpoint aberto sem chave |
| `src/auto-close.js` | encerra pedidos no horário | `loyalty-rules`, `db` (dinâmico) | `server.js` | fuso `America/Sao_Paulo`; duplica regra do pedido | — | duplicação | P1-03, P1-04 | P1 | divergência de regra |
| `src/demo-mode.js` | loja de demonstração automática | `db` | `server.js` | consulta a cada 4 s; scan de auditoria | — | duplica regra do pedido | P1-01, P1-03, P3-01 | P1 | custo e desempenho |
| `src/customer-pets.js` | pets do cliente | zod | `server`, `pet-records` | — | dados pessoais (SEC-10) | ok | `modules/customers` | P3 | — |
| `src/pet-records.js` | prontuário | `customer-pets` | `server` | — | dados pessoais | ok | idem | P3 | — |
| `src/partners.js` | mapa público de parceiros | zod, rate-limit | `server` | cache em memória | dados públicos por opção | ok | — | P4 | — |
| `src/legacy-import.js` | importação de clientes antigos | zod | `server` | — | LGPD (origem dos dados) | ok | — | P4 | — |
| `src/store-tools.js` | atalhos, links úteis, devedores, importação | crypto, zod | `server` | — | URLs só http(s) (bom) | ok | `modules/store-settings` | P4 | — |

## 2. Banco (`sql/`, 59 arquivos)

| Arquivo(s) | Responsabilidade | Problemas | Segurança | Refatoração | Prior. |
|---|---|---|---|---|---|
| `001_init.sql` | tabelas base (tenants, users, cameras, customers, processes, orders, recordings, invoices, audit_events) | `audit_events` sem índice por alvo; `users.email` UNIQUE sem `lower()`; colunas legadas (`storage_key`) | sem RLS/GRANT | índices P1-01/P3-03 | P1 |
| `009_order_share_links.sql` | `share_code` | guardado em claro | SEC-17 | hash do código | P2 |
| `020_short_order_links.sql` | número curto do pedido (trigger) | espaço de 4 dígitos | SEC-02 | P0-05 | P0 |
| `048_customer_pets.sql`, `048_split_payments.sql` | pets; pagamento dividido | **número duplicado** | — | runner por nome aceita ambos (P4-05) | P4 |
| `003`…`058` (demais) | evolução incremental, majoritariamente aditiva (ALTER ADD, CREATE IF NOT EXISTS) | 6 `UPDATE` de dados em migrations (`009`, `018`, `020`, `055`, `057`) — corretos, mas sem reversão | — | padrão: migrations só aditivas + scripts de dados separados | P3 |
| `003_quick_orders_integrations.sql` | inclui `integration_connections` | tabela sem uso no código | — | confirmar e remover (P4-04) | P4 |

## 3. Frontend (`public/`)

| Arquivo | Responsabilidade | Dependências | Dependentes | Problemas | Segurança | Refatoração | Prior. |
|---|---|---|---|---|---|---|---|
| `tracking.html` | página pública do pedido, player HLS, fidelidade | hls.js (jsDelivr) | `/p/:token`, link curto | polling 15 s; script inline grande | SEC-04 (sem SRI/CSP), SEC-10 (visitante) | P1-06, P2-05 (primeira a migrar) | P1 |
| `loja.html` + `store.js` (108 KB) | painel de pedidos/clientes/processos | `icons`, `store-ux` | owner/operator | polling 5 s da lista completa | escape presente | P1-02, P2-05 | P1 |
| `store-sales.js` (316 KB) | caixa, vendas, estoque, mensagens | `store.js` (globais) | `loja.html` | 417 linhas > 200 caracteres | 129 `innerHTML` (escape presente) | P2-05 | P2 |
| `store-tools.js`, `store-ux.js`, `customer-history.js`, `pets-panel.js`, `legacy-import.js` | ferramentas, UX, histórico, pets, importação | globais | `loja.html` | helpers duplicados | escape presente | P2-05 | P3 |
| `central.html` + `app.js` (45 KB/197 linhas), `central-analytics.js` | painel master | `icons` | master | linhas de até 3.045 caracteres | maior alvo de XSS (dados de lojas → master) | P1-06, P2-05 | P2 |
| `entrar.html` | login | — | todos | sem troca/redefinição de senha | SEC-01, SEC-19 | P0-06 | P0 |
| `tecnico.html` | painel do técnico | — | technician | — | token em `sessionStorage` | P2-05 | P4 |
| `contato.html` | QR de contato, "meus pedidos" | — | `/<loja>/oi` | — | SEC-18 | — | P3 |
| `index.html`, `o-que-e`, `planos`, `segmentos`, `privacidade`, `fale-conosco`, `lojas.html` | site institucional, mapa de parceiros | Leaflet, OSM, Google Fonts | público | fontes externas | SEC-10 (IP a terceiros) | fontes locais (P2-07) | P4 |
| `loja-legado.html`, `loja-preview.html` | protótipos antigos | — | só entre si / rota explícita | provável código morto | superfície desnecessária | P4-04 | P4 |
| `icons.js`, CSS (5) | ícones e estilos | — | páginas | estilos inline espalhados | — | design tokens no `web/shared` | P4 |
| `vendor/leaflet/*` | biblioteca de terceiros 1.9.4 | — | `lojas.html` | — | versão atual (SEC-25) | — | — |
| `img/*`, `demo/*` | mídia | — | páginas | vídeos servidos pelo Node | — | CDN/R2 (PERF-08) | P4 |

## 4. Borda, mídia e agente

| Arquivo | Responsabilidade | Problemas | Segurança | Refatoração | Prior. |
|---|---|---|---|---|---|
| `edge/video-worker.js` | entrega HLS/gravações pela Cloudflare com token AES-GCM e revalidação | — | SEC-20 (revogação depende do Render) | validade menor (opcional) | P4 |
| `media/docker-compose.yml`, `docker-compose.push.yml`, `.env.example`, `README.md` | MediaMTX central (modo legado) | modo legado | portas só em localhost (bom) | arquivar após P3-02 | P4 |
| `installer/windows/payload/FicouPronto.psm1` (37 KB) | núcleo do agente: config, DPAPI, MediaMTX, heartbeat, backup, verificação de assinatura | arquivo grande | SEC-22 (`any` local) | separar em módulos menores | P3 |
| `installer/windows/payload/ficoupronto-setup.ps1`, `-agent.ps1`, `-updater.ps1` | instalação, serviço, atualizador com rollback | — | `api-base.txt` ao lado do script sobrescreve a API (só admin escreve em Program Files: validar) | — | P4 |
| `installer/windows/FicouPronto.nsi`, `build.sh`, `vendor.lock`, `THIRD_PARTY.txt` | build do instalador com hashes | ffmpeg aponta para "latest" (hash quebra) | binários verificados (bom) | fixar versão do ffmpeg | P4 |
| `connect/windows/*` (11) | geração anterior do agente + testes | duplica função do `installer/` | — | confirmar uso e arquivar (P4-04) | P4 |

## 5. Configuração, scripts, CI e docs

| Arquivo | Responsabilidade | Problemas | Segurança | Refatoração | Prior. |
|---|---|---|---|---|---|
| `package.json` / `package-lock.json` | dependências e scripts | sem `test`; Playwright não declarado | `npm install` no Render (usar `npm ci`) | P0-02 | P0 |
| `render.yaml` | serviço Render | só 3 variáveis declaradas; sem pre-deploy | — | P0-04 | P0 |
| `.env.example` | exemplo de configuração | incompleto (9 de 38 variáveis) | — | gerar a partir de `config/env.js` | P1 |
| `.gitignore` | ignora `.env*`, `node_modules`, logs | não ignora `agent-releases/` nem chaves (o script já bloqueia chave dentro do repo) | — | adicionar entradas | P4 |
| `.github/workflows/reports-cron.yml` | ping de relatórios | URL padrão fixa | depende de `REPORTS_CRON_KEY` | P1-09 | P1 |
| `.github/workflows/windows-agent.yml` | testes do agente | só o agente é testado | — | modelo para o CI da API | P0 |
| `scripts/agent-release.mjs` | gera chave e pacote assinado | — | impede chave privada no repo (bom) | — | P4 |
| `scripts/site-screenshots.mjs` | screenshots do site (Playwright) | — | — | usar em regressão visual (P2-05) | P4 |
| `README.md` | visão geral | **obsoleto** | — | P4-05 | P4 |
| `docs/*.md` (10) | runbooks e diagnósticos de vídeo/agente | — | — | manter; indexar | P4 |

## 6. Testes (`test/`, 60 arquivos)

| Grupo | Arquivos | Observação | Prior. |
|---|---|---|---|
| Helper | `test/helpers/store-fixture.js` | schema aleatório, trava de banco local (bom); JWT assinado direto (login não é testado) | P0 |
| Integração API (sem navegador) | ~24 `*.integration.test.js` | cobrem pedidos, câmeras, vendas, estoque, backup, borda, agente | P0 (levar ao CI) |
| Painel (Playwright) | ~35 `*-panel.integration.test.js` e similares | acoplados ao HTML atual; úteis como rede de segurança durante a refatoração | P0/P2 |
| Agente Windows | `connect/windows/tests/*.ps1` | rodam no CI | — |
| Lacunas | login, backup inspect/export/restore, overview, status do dispositivo; testes unitários de regras | P0-02, P4-03 | P1 |
