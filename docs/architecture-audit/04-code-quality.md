# 04 — Qualidade de código e dívida técnica (Fase 5)

> Análise estática de `develop` (= `main` @ `844b19a`). Métricas obtidas por contagem direta nos arquivos.

## 1. Resumo

O código é **funcionalmente cuidadoso** (validação em todas as rotas, transações corretas, mensagens de erro
claras para o usuário, comentários explicando o "porquê" em português) e **estruturalmente frágil**
(arquivos enormes, linhas muito longas, duplicação, nenhum tipo, nenhum lint, testes fora do CI). O padrão é
típico de desenvolvimento rápido por IA em pequenos PRs: cada funcionalidade nova foi **acrescentada** no
arquivo mais próximo, sem refatorar o que já existia.

| Indicador | Valor | Leitura |
|---|---|---|
| Código-fonte próprio (JS backend + frontend) | ~1,45 MB | grande para 16 dias |
| Maior arquivo | `public/store-sales.js` 316 KB / 2.637 linhas | difícil de revisar e de testar |
| Linhas > 200 caracteres | `server.js` 121 · `store-sales.js` (front) 417 · `store.js` 151 · `app.js` 67 | leitura e diffs ruins |
| Linhas > 1.000 caracteres | 19 (máx. 3.045 em `app.js`) | praticamente ilegíveis em revisão |
| Funções de escape HTML duplicadas | 11 arquivos | risco de divergência (SEC-04) |
| Cliente HTTP (`api()`) duplicado | 8 arquivos | idem |
| Tipagem | nenhuma (sem TypeScript, sem JSDoc de tipos) | erros só em tempo de execução |
| Lint/formatador | nenhum (`.eslintrc`, `.prettierrc`, `.editorconfig` ausentes) | estilo inconsistente |
| TODO/FIXME | 2 | baixo — bom sinal |
| Testes | 59 arquivos, 90 casos; 58 exigem Postgres, 35 exigem navegador | só integração/E2E |
| Rotas citadas em testes | ~209 de 231 (~90%, por correspondência de caminho) | boa amplitude, mas… |
| Testes no CI | **nenhum** da API | …a cobertura não protege o deploy |

## 2. Problemas por categoria

### 2.1 Arquivos e funções monolíticos

| Arquivo | Responsabilidades misturadas | Ação |
|---|---|---|
| `src/server.js` (99 KB) | bootstrap, auth, helpers, 92 rotas de 10 domínios, proxy de vídeo, timers, handler de erro | dividir em `app.js` (montagem), `http/` (middlewares), módulos por domínio |
| `src/store-sales.js` (135 KB, ~70 rotas) | caixa, vendas, produtos, variantes, estoque, etiquetas, fornecedores, serviços, a receber, cashback, fidelidade, mensagens, histórico | separar em `cash/`, `sales/`, `catalog/`, `stock/`, `receivables/`, `messaging/` |
| `public/store-sales.js` (316 KB) | todas as telas do caixa e do estoque | módulos ES por tela + componentes compartilhados |
| `public/store.js` (108 KB) | pedidos, clientes, processos, câmeras, configurações | idem |
| `public/app.js` (45 KB em 197 linhas) | toda a central | formatar e modularizar |

Funções extensas típicas: `createSale`, usada por `POST /api/store/sales` e por "receber venda pendente" (~180 linhas, `store-sales.js:1009-1190`),
`POST /api/orders/:id/transition` (`server.js:501-545`, ~45 linhas densas), `resolveLive` + proxy HLS
(`server.js:587-679`).

### 2.2 Duplicação

| O que | Onde | Risco |
|---|---|---|
| Ciclo de vida do pedido | `server.js:501-545`, `auto-close.js:20-27`, `demo-mode.js:59-62,118-120` | regras divergem: o auto-close conclui sem a notificação por e-mail que a transição normal envia (`server.js:543`) e sem as checagens de estado esperado |
| "Câmera da etapa" | JS `server.js:32` + SQL em `server.js:527,594,611` | idem |
| Boilerplate de transação (`connect/BEGIN/COMMIT/ROLLBACK/release`) | ~108 ocorrências | esquecer `ROLLBACK`/`release` vaza conexão |
| Hash SHA-256 de token | `digestToken` + 6 cópias de `createHash('sha256')` | inconsistência |
| Fuso horário | `STORE_TZ='America/Sao_Paulo'` (`auto-close.js:7`) × `'America/Fortaleza'` em 5 arquivos e fixo em SQL (`server.js:216`) | hoje os dois são UTC-3 sem horário de verão; divergem se as regras mudarem ou se surgir loja em outro fuso |
| Escape HTML, `api()`, formatação de dinheiro | 11 / 8 / 3 arquivos do frontend | correção feita num lugar e não nos outros |
| Validação do pedido (`orderDetails`) passada por parâmetro | `server.js:39` → `store-sales.js` | acoplamento implícito |
| `slugFromName`, regex de token `^[\w-]{16,100}$` | repetidos em várias rotas | idem |

### 2.3 Nomenclatura e consistência

- Mistura de português (domínio, mensagens, comentários) e inglês (código, tabelas): aceitável, mas sem regra.
- Duas marcas no código: `nextvision`/`nv_` e `ficoupronto`/`fp_` (tokens, chaves de storage, funções SQL `fp_fold`, `nv_assign_order_number`).
- Nomes curtos e opacos em código denso: `q`, `c`, `v`, `o`, `r`, `tid`, `bad`.
- Duas gerações do agente (`connect/windows` "NextVision Connect" × `installer/windows` "Ficou Pronto").

### 2.4 Tratamento de erros e logs

- Handler único bom para não vazar detalhes, mas sem stack nem ID de requisição (`server.js:810`).
- `catch(() => {})` silencioso em analytics, e-mail e fidelidade: falhas reais desaparecem.
- Validação zod devolve sempre "Dados inválidos" sem indicar o campo — atrapalha o usuário e o suporte.
- 26 `console.*` no backend, sem nível nem formato.

### 2.5 Código morto ou suspeito

| Arquivo | Evidência | Recomendação |
|---|---|---|
| `public/loja-legado.html` | só referenciado por `loja-preview.html` | confirmar no log de acesso e remover |
| `public/loja-preview.html` | rota explícita `server.js:786`, título "NextVision Premium Flow" | confirmar uso; provavelmente protótipo |
| `connect/windows/*` | substituído por `installer/windows` (hipótese) | confirmar quais lojas ainda usam; arquivar |
| `media/docker-compose*.yml` | modo "uma origem central" (legado), ainda suportado por `legacyMediaConfig()` | manter até todas as lojas terem mídia própria |
| `invoices` / `GET /api/master/invoices` | nenhuma rota cria faturas; `billing_automation_configured:false` fixo (`server.js:250`) | funcionalidade incompleta: decidir |
| `integration_connections` (tabela, `sql/003`) | nenhuma referência em `src/` | verificar e remover se morta |
| `recordings.storage_key` (`sql/001`) | não usado (gravações ficam no PC) | coluna legada |

### 2.6 Testes

**Pontos fortes**: testes de integração reais (banco isolado por schema aleatório, trava contra banco não
local em `test/helpers/store-fixture.js:16`), cenários de concorrência e de isolamento entre lojas
(`foreignToken`), testes de painel com navegador, testes do agente Windows no CI.

**Fragilidades**:
1. Nenhum teste da API roda no CI; dependem de Postgres e Chromium locais e de variáveis manuais.
2. Não existe script `npm test`; Playwright não está declarado.
3. Sem testes unitários das regras (máquina de estados, preço por época, cashback, fidelidade) — tudo passa por HTTP.
4. Rotas críticas sem teste: `POST /api/auth/login`, `/api/master/backups/inspect|export|restore`, `GET /api/master/overview`, `/api/connect/status`.
5. Testes de painel dependem de seletores do HTML monolítico: qualquer refatoração do frontend quebra muitos testes ao mesmo tempo (bom como rede de segurança, caro de manter).
6. Sem medição de cobertura.

### 2.7 Dependências

Enxutas (9 diretas, 130 no total). Sem dependências desnecessárias. Faltam declarar: `playwright`
(desenvolvimento). `dotenv` é desnecessário no Node ≥ 20.6 (`--env-file`), mas inofensivo.

## 3. Dívida técnica priorizada

| ID | Item | Impacto | Esforço | Prioridade |
|---|---|---|---|---|
| QLD-01 | Testes da API no CI (Postgres de serviço) + `npm test` + Playwright declarado | alto — protege toda refatoração | baixo | **P1** (pré-requisito de tudo) |
| QLD-02 | Unificar ciclo de vida do pedido num serviço | alto | médio | P1 |
| QLD-03 | Fuso horário único configurável por loja | médio | baixo | P1 |
| QLD-04 | Lint + formatador (ESLint + Prettier) aplicados por pasta, sem reformatar tudo de uma vez | médio | baixo | P2 |
| QLD-05 | Helper de transação (`withTransaction`) e de escape/`api()` únicos | médio | baixo | P2 |
| QLD-06 | Quebrar `server.js` e `store-sales.js` por domínio | alto | alto | P2 |
| QLD-07 | Modularizar o frontend (ES modules + build) | alto | alto | P2/P3 |
| QLD-08 | Tipagem gradual (JSDoc `// @ts-check` → TypeScript) | médio | médio | P4 |
| QLD-09 | Erros de validação com campo; logs estruturados | médio | baixo | P2 |
| QLD-10 | Remover código morto confirmado; atualizar README | baixo | baixo | P4 |
| QLD-11 | Renumerar/automatizar lista de migrations (sem renomear as já aplicadas) | baixo | baixo | P3 |
