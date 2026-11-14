# 01 — Inventário do projeto

> Fase 0/1 da auditoria. Gerado por leitura estática do repositório na branch local `develop`
> (criada a partir de `main` @ `844b19a`). Nada foi executado, instalado ou conectado.
> Convenção: **[FATO]** comprovado no código · **[HIPÓTESE]** inferência a validar · **[REC]** recomendação.

## 1. Estado do Git (Fase 0)

| Item | Resultado |
|---|---|
| Branch de origem | `main` @ `844b19a`, idêntica a `origin/main` (conferido com `git ls-remote`) |
| Branch de trabalho | `develop` (local, criada nesta auditoria, **sem push**) |
| Branches remotas | 118 (`feat/*`, `fix/*`, `release/*`, `wip/*` e algumas sem prefixo) — nenhuma tocada |
| Alterações não commitadas | apenas `specs/` (não rastreado, preservado) |
| Stash / submódulos | nenhum |
| Histórico | 281 commits entre 28/10/2026 e 13/11/2026 (≈ 16 dias) |
| `.gitignore` | `node_modules/`, `.env`, `.env.*` (exceto `.env.example`), `*.log` |

## 2. Identidade do produto

- Nome técnico/repositório: **NextVision** (`package.json`, logs, tabelas `nextvision_schema_migrations`).
- Nome comercial: **Ficou Pronto** (títulos HTML, instalador `FicouPronto.nsi`, domínio `ficoupronto.com`).
- Objetivo **[FATO]**: SaaS multi-tenant para lojas de serviço (pet shop é o nicho principal; também oficina,
  funilaria, lava-jato, assistência técnica, alimentação — `src/store-profile.js`). O cliente final acompanha o
  pedido por link público com etapas e **vídeo ao vivo** da câmera da loja. Evoluiu para incluir caixa/PDV,
  estoque, fidelidade/cashback, mensagens de WhatsApp (via `wa.me`), prontuário de pets, relatórios por e-mail,
  backup por loja e um agente Windows instalado no PC da loja.

## 3. Stack tecnológica

| Camada | Tecnologia | Evidência |
|---|---|---|
| Runtime | Node.js ≥ 20, ESM | `package.json` (`engines`, `"type":"module"`) |
| HTTP | Express 4.21 + helmet 8 (**CSP desligada**) + express-rate-limit 7 | `src/server.js:12` |
| Auth | jsonwebtoken 9 (HS256), bcryptjs 2.4 (custo 12) | `src/server.js:19,43,166` |
| Validação | zod 3.24 | todos os módulos |
| Banco | PostgreSQL via `pg` 8.13 (Pool max 10, TLS verificado), **SQL manual, sem ORM** | `src/db.js` |
| Migrations | 59 arquivos SQL; lista fixa em `src/migrate.js`; advisory lock + transação única | `src/migrate.js` |
| Frontend | HTML/CSS/JS puro, sem build, sem framework; Leaflet embutido; hls.js via jsDelivr | `public/` |
| Borda | Cloudflare Worker (ES module) para HLS; Cloudflare Tunnel por loja | `edge/video-worker.js`, `src/cloudflare.js` |
| Mídia | MediaMTX (RTSP→HLS, gravação, playback :9996) no PC da loja ou via docker-compose | `media/`, `installer/` |
| Agente da loja | PowerShell 5.1 (módulos `.psm1`), WinSW, cloudflared, ffmpeg; instalador NSIS | `connect/windows/`, `installer/windows/` |
| E-mail | Resend (HTTP API) | `src/server.js:40`, `src/reports.js` |
| Testes | `node:test` + Playwright (não declarado em `package.json`) + Postgres local | `test/` |
| Hospedagem | Render (web service Node, health `/health`) | `render.yaml` |
| Banco gerenciado | Neon (citado no README e comentário em `src/db.js`) **[HIPÓTESE forte]** | `README.md`, `src/db.js:10` |
| CI | GitHub Actions: cron de relatórios e testes do agente Windows | `.github/workflows/` |

### Dependências de produção (9)

`bcryptjs ^2.4.3`, `dotenv ^16.4.5`, `express ^4.21.2`, `express-rate-limit ^7.5.0`, `helmet ^8.0.0`,
`jsonwebtoken ^9.0.2`, `pg ^8.13.1`, `qrcode ^1.5.4`, `zod ^3.24.2`. Não há `devDependencies`.
Existe `package-lock.json` (versões exatas serão avaliadas na Fase 3 — SCA, sem instalar nada).

### Dependências implícitas (não declaradas)

| Item | Onde | Observação |
|---|---|---|
| `playwright` | 30+ testes `*-panel.integration.test.js`, `scripts/site-screenshots.mjs` | não está no `package.json` |
| `hls.js@1.6.15` | `public/tracking.html:287` (jsDelivr) | CDN externo; SRI a verificar na Fase 3 |
| Fontes Google | vários HTML | dependência externa de terceiros |
| cloudflared, WinSW, MediaMTX, ffmpeg | `installer/windows/vendor.lock` | fixados por SHA-256; ffmpeg aponta para "latest" |

## 4. Inventário de diretórios (239 arquivos rastreados)

| Diretório | Arquivos | Bytes (texto) | Classificação |
|---|---|---|---|
| `src/` | 27 | 434 KB | Código-fonte backend — **auditar integralmente** |
| `public/` | 48 | 1,0 MB (sem mídia) | Frontend + páginas do site — auditar; `vendor/` e mídia só inventariar |
| `sql/` | 59 | 72 KB | Migrations — auditar |
| `test/` | 60 | 547 KB | Testes de integração — auditar cobertura/qualidade |
| `connect/windows/` | 11 | 122 KB | Agente Windows (geração "NextVision Connect") — auditar |
| `installer/windows/` | 9 | 97 KB | Instalador/agente (geração "Ficou Pronto") — auditar |
| `edge/` | 1 | 12 KB | Cloudflare Worker — auditar |
| `media/` | 4 | — | docker-compose MediaMTX — auditar |
| `scripts/` | 2 | 15 KB | Release do agente e screenshots — auditar |
| `docs/` | 10 | 63 KB | Documentação operacional — ler como contexto, não como verdade |
| `.github/workflows/` | 2 | — | CI/cron — auditar |
| raiz | 6 | — | `package*.json`, `render.yaml`, `.env.example`, `README.md`, `.gitignore` |

### Arquivos não-fonte (inventariados, não auditados como código)

| Arquivo | Tipo |
|---|---|
| `public/demo/pet/*.mp4` (4), `final.jpg` | vídeos/imagem da loja de demonstração |
| `public/img/site/*.webp` (11) | imagens do site institucional |
| `public/vendor/leaflet/*` | biblioteca de terceiros (versão a confirmar) |
| `package-lock.json` | lockfile gerado |
| `installer/windows/THIRD_PARTY.txt`, `vendor.lock` | licenças e hashes de binários de terceiros |

### Maiores arquivos de código (densidade alta — linhas longas)

| Arquivo | Bytes | Linhas | Maior linha |
|---|---|---|---|
| `public/store-sales.js` | 316 KB | 2.637 | 2.124 chars |
| `src/store-sales.js` | 135 KB | 1.416 | 376 chars |
| `public/store.js` | 108 KB | 801 | 2.024 chars |
| `src/server.js` | 99 KB | 812 | 1.570 chars |
| `public/app.js` | 45 KB | 197 | 3.045 chars |

## 5. Arquivos de configuração e infraestrutura

| Arquivo | Conteúdo relevante |
|---|---|
| `render.yaml` | 1 web service `nextvision-api`, `npm install` + `npm start`, health `/health`; segredos `DATABASE_URL`, `JWT_SECRET`, `PUBLIC_BASE_URL` (`sync:false`) |
| `.env.example` | chaves: `DATABASE_URL`, `JWT_SECRET`, `BOOTSTRAP_ADMIN_*`, `PUBLIC_BASE_URL`, `PORT`, `EDGE_VIDEO_*` (valores não reproduzidos) |
| `media/docker-compose.yml` | MediaMTX com portas só em `127.0.0.1`, WebRTC/RTMP/SRT/API/metrics desligados |
| `media/docker-compose.push.yml`, `media/.env.example` | variante "push"; `CAMERA_RTSP_URL` |
| `.github/workflows/reports-cron.yml` | ping a cada 10 min em 2 janelas para `POST /api/internal/reports/run` com `x-cron-key` |
| `.github/workflows/windows-agent.yml` | testes PowerShell (5.1 e 7) do agente em `windows-latest` |
| `installer/windows/build.sh`, `FicouPronto.nsi` | build do instalador NSIS com binários verificados por hash |

### Variáveis de ambiente lidas pelo código (nomes apenas)

`DATABASE_URL`, `DB_SSL`, `JWT_SECRET`, `PORT`, `PUBLIC_BASE_URL`, `SHORT_LINK_BASE_URL`, `BOOTSTRAP_ADMIN_EMAIL`,
`BOOTSTRAP_ADMIN_PASSWORD`, `RESEND_API_KEY`, `EMAIL_FROM`, `REPORTS_CRON_KEY`, `MEDIA_SECRET_KEY`,
`STORE_BACKUP_KEY`, `STOCK_VALUE_LOGIN`, `STOCK_VALUE_PASSWORD_HASH`, `STORE_TIMEZONE`, `MEDIA_DOMAIN`,
`MEDIA_UPSTREAM_URL`, `MEDIA_USERNAME`, `MEDIA_PASSWORD`, `LIVE_CAMERA_ID`, `MEDIA_MULTI_CAMERA_ENABLED`,
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_BASE`, `EDGE_VIDEO_KEY`,
`EDGE_VIDEO_HOST`, `EDGE_VIDEO_TENANTS`, `EDGE_VIDEO_CHECK_URL`, `EDGE_VIDEO_ALLOWED_ORIGINS`,
`EDGE_VIDEO_ASSUME_READY`, `AGENT_RELEASES_DIR`, `AUTO_CLOSE_INTERVAL_MS`, `NEXTVISION_RELEASE`,
`NEXTVISION_BUILD_REVISION`, `RENDER_GIT_COMMIT`, `FP_DEBUG`.
**[FATO]** `render.yaml` declara apenas 3 dessas; as demais são configuradas manualmente no painel do Render
(fora do controle de versão).

### Serviços externos identificados

| Serviço | Uso | Evidência |
|---|---|---|
| Render | hospedagem da API + site | `render.yaml`, `reports-cron.yml` (URL `*.onrender.com`) |
| PostgreSQL (Neon) | banco principal | `src/db.js` |
| Cloudflare API | criar túnel/DNS por loja, publicar Worker e domínio | `src/cloudflare.js` |
| Cloudflare Worker | entrega de HLS e download de gravações | `edge/video-worker.js` |
| Resend | e-mail de notificação e relatórios | `src/server.js:40`, `src/reports.js` |
| ViaCEP | consulta de CEP no frontend | `public/` |
| OpenStreetMap tiles | mapa de parceiros (`lojas.html`) | `public/` |
| jsDelivr, Google Fonts | hls.js e fontes | `public/*.html` |
| GitHub Releases | binários do instalador | `installer/windows/vendor.lock` |
| WhatsApp (`wa.me`) | só links; nenhuma API | `src/store-qr.js`, `src/store-sales.js` |

## 6. Primeiras observações de inventário

1. **[FATO]** Duas migrations com número `048_` (`048_customer_pets.sql`, `048_split_payments.sql`); a ordem depende da lista fixa em `src/migrate.js`.
2. **[FATO]** Não há script `test` no `package.json`; os testes exigem `TEST_DATABASE_URL` local, `BROWSER_EXECUTABLE` e às vezes `PWSH_BINARY`.
3. **[FATO]** `README.md` está desatualizado (diz "não validado em produção" e descreve um escopo muito menor).
4. **[FATO]** `agent-releases/` (pacotes assinados do agente) não está no repositório; o servidor lê de `AGENT_RELEASES_DIR` ou `../agent-releases`. Origem desses arquivos em produção: **[HIPÓTESE]** a validar.
5. **[FATO]** Duas gerações do agente Windows coexistem: `connect/windows` (NextVision Connect, por usuário) e `installer/windows/payload` (Ficou Pronto, serviço com admin).
6. **[FATO]** Páginas `public/loja-legado.html` e `public/loja-preview.html` só se referenciam entre si (e a prévia tem rota explícita em `src/server.js:786`) — candidatas a código morto, **a confirmar** com dados de acesso.
7. **[FATO]** Busca por padrões de segredos conhecidos (chaves AWS/GitHub/Slack/Google, chaves privadas PEM, URLs Postgres com senha) **não encontrou ocorrências** nos arquivos rastreados. Isso não comprova ausência de segredos (histórico do Git ainda não foi varrido).
