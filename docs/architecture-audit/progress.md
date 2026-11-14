# Progresso da auditoria

> Controle de cobertura exigido pela spec (seção 7): a auditoria só é declarada completa quando todos os
> arquivos relevantes estiverem contabilizados. Atualizado ao fim de cada fase.

## Fases

| Fase | Situação | Entregável |
|---|---|---|
| 0 — Inventário e isolamento | concluída | `01-project-inventory.md` §1 |
| 1 — Engenharia reversa | concluída (mapa arquitetural) | `01-project-inventory.md`, `02-current-architecture.md` |
| 2 — Arquitetura | concluída | `02-current-architecture.md` Parte B |
| 3 — Segurança | concluída (estática; itens dinâmicos listados no §4 do documento) | `03-security-audit.md` |
| 4 — Performance | concluída (estática; volumes reais a medir) | `05-performance-scalability.md` |
| 5 — Qualidade | concluída | `04-code-quality.md` |
| 6 — Tecnologia | concluída | `06-technology-assessment.md` |
| 7 — Arquitetura-alvo | concluída | `07-target-architecture.md` |
| 8 — Roadmap | concluída | `08-refactoring-roadmap.md`, `10-risk-register.md` |
| Análise por arquivo | concluída | `09-file-by-file-analysis.md` |
| Resumo executivo | concluído | `00-executive-summary.md` |

## Situação da auditoria

**Todos os 239 arquivos rastreados estão contabilizados** (classificados e com responsabilidade registrada em
`01`/`09`). A auditoria **não é declarada exaustiva** porque parte do código foi revisada por mapeamento e
varreduras dirigidas, não linha a linha (tabela abaixo). Os achados nesses arquivos vêm de varreduras
completas por padrão (SQL dinâmico, filtros de loja, sinks de HTML, timers, URLs) e de leitura dos trechos
críticos. Recomenda-se completar a leitura integral durante a execução de P2 (cada módulo é relido ao ser
extraído), e fazer a validação dinâmica listada em `03-security-audit.md` §4.

Varreduras completas executadas sobre todo o código-fonte:
- consultas SQL com interpolação (`${…}`) → todas de listas fixas ou chaves validadas;
- consultas por `id` sem `tenant_id` → todas precedidas de checagem de escopo;
- atribuições de HTML (`innerHTML`) com campos textuais → escape presente em todos os casos revisados;
- padrões de segredos no histórico completo do Git → nenhum encontrado;
- rotas citadas em testes → ~90%;
- grafo de dependências entre módulos → 2 ciclos.

Arquivos auxiliares desta auditoria (fora do repositório): `E:\projetos\_audit-tmp\` (`route-coverage.mjs`,
`deps.mjs`). A varredura de HTML usou um script temporário equivalente.

## Cobertura de leitura

Legenda: **integral** = lido linha a linha · **mapeado** = rotas, exports, cabeçalho e trechos-chave ·
**inventariado** = classificado, sem auditoria de conteúdo · **pendente** = ainda não aberto.

### Backend `src/` (27)

| Arquivo | Nível |
|---|---|
| `server.js`, `start.js`, `db.js`, `migrate.js`, `bootstrap.js` | integral |
| `store-media.js`, `cloudflare.js`, `edge-video.js`, `secret-box.js`, `store-backup.js` | integral |
| `agent-releases.js`, `store-admin.js`, `store-qr.js`, `auto-close.js`, `store-profile.js` | integral |
| `store-sales.js` | mapeado + revisão de segurança dirigida (SQL dinâmico, ids do corpo/URL, venda, caixa, recibo, produtos) — leitura integral pendente (Fase 5) |
| `reports.js`, `link-analytics.js` | mapeado (endpoints públicos/cron lidos) — integral pendente |
| `store-tools.js`, `store-performance.js`, `stock-value.js`, `customer-pets.js`, `pet-records.js`, `loyalty-rules.js`, `demo-mode.js`, `partners.js`, `legacy-import.js` | mapeado — integral pendente |

### Banco `sql/` (59)

| Escopo | Nível |
|---|---|
| Objetos (tabelas, views, funções, triggers, índices, FKs, UPDATEs de dados) | mapeado em todas |
| `001_init.sql`, `009`, `020` | integral |
| Demais 56 | pendente leitura integral (Fases 3/4) |

### Frontend `public/` (48)

| Escopo | Nível |
|---|---|
| Páginas ↔ scripts, armazenamento de token, uso de `innerHTML`, CDNs | mapeado |
| `app.js`, `store.js`, `store-sales.js`, `store-tools.js`, `store-ux.js`, `customer-history.js`, `pets-panel.js`, `central-analytics.js`, `legacy-import.js`, `icons.js` e HTML inline | pendente leitura integral (Fases 3/5) |
| `vendor/leaflet/*`, `img/*`, `demo/*` | inventariado (terceiros/mídia) |
| CSS (5) | inventariado |

### Demais

| Escopo | Nível |
|---|---|
| `edge/video-worker.js` | cabeçalho e contratos — integral pendente |
| `connect/windows/*` (11), `installer/windows/*` (9) | cabeçalhos, endpoints usados, `vendor.lock` — integral pendente |
| `media/*` (4), `render.yaml`, `.github/workflows/*` (2), `package.json`, `.env.example` | integral |
| `scripts/*` (2) | pendente |
| `test/*` (60) | listados; helper `store-fixture.js` lido parcialmente — avaliação pendente (Fase 5) |
| `docs/*` (10) | pendente (contexto) |
| Histórico do Git (segredos já removidos) | pendente (Fase 3) |
