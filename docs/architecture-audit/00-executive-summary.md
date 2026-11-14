# 00 — Resumo executivo

> Auditoria arquitetural e de segurança do **Ficou Pronto / NextVision**, feita por leitura estática do
> repositório na branch local `develop` (= `main` @ `844b19a`). Nada foi executado contra a produção, nenhum
> banco foi acessado, nenhuma dependência foi instalada e nada foi enviado a serviços externos.

## 1. O que é o sistema

SaaS multi-lojas (foco em pet shops) em que o cliente final acompanha o atendimento por um link, com etapas,
fotos e **vídeo ao vivo** da câmera da loja. Em 16 dias de desenvolvimento (281 commits) ganhou também caixa,
estoque, fidelidade, cashback, mensagens por WhatsApp, prontuário de pets, relatórios por e-mail, backup
cifrado e um agente Windows que liga as câmeras à nuvem.

**Stack**: Node 20 + Express + PostgreSQL (Neon) no Render; frontend HTML/JS sem build; vídeo com MediaMTX
no PC da loja → Cloudflare Tunnel → Cloudflare Worker; agente em PowerShell.

## 2. Estado geral

| Dimensão | Avaliação |
|---|---|
| Funcionalidade e regras de negócio | **Boa** — transações, travas e concorrência tratadas com cuidado |
| Segurança de base (SQL, isolamento entre lojas, uploads, criptografia) | **Boa** — sem SQL injection, isolamento consistente, tokens com hash |
| Identidade e acesso | **Fraca** — sem troca/redefinição de senha, sem MFA, link curto adivinhável |
| Operação e deploy | **Frágil** — iniciar o app migra o banco e publica na Cloudflare; sem staging; testes fora do CI |
| Desempenho | **Adequado hoje, com dois gargalos de crescimento comprovados** |
| Manutenibilidade | **Baixa** — arquivos de até 316 KB, regras duplicadas, sem tipos, sem lint |
| Escalabilidade | **Uma instância** por desenho (estado e timers em memória) |
| LGPD | **Incompleta** — sem retenção/anonimização e sem atendimento ao titular |

**Conclusão**: o sistema **não precisa ser reescrito**. A stack é adequada. O caminho é: blindar a operação
(ambiente isolado, CI, staging, boot sem efeitos), corrigir os três riscos altos de segurança e, só então,
reorganizar o código em módulos por domínio, passo a passo, com testes protegendo cada mudança.

## 3. Principais riscos

| # | Risco | Severidade | Documento |
|---|---|---|---|
| 1 | **Link curto do pedido adivinhável** (`/<loja>/<4 dígitos>`) dá acesso ao vídeo ao vivo, fotos, gravações e cupom de outro cliente | Alta | SEC-02 |
| 2 | **Nenhuma troca ou redefinição de senha**, inclusive do master; senha vazada não pode ser trocada | Alta | SEC-01 |
| 3 | **Iniciar a aplicação altera a produção** (migrations, Worker da Cloudflare, jobs que concluem pedidos); sem staging nem testes no CI | Alta | SEC-03 |
| 4 | Master sem MFA e limite de tentativas só por IP (em memória) | Média | SEC-05, SEC-09 |
| 5 | Página pública varre a tabela de auditoria inteira a cada atualização; painel baixa todo o histórico a cada 5 s | Desempenho | PERF-01, PERF-02 |
| 6 | Sem CSP: um escape esquecido no frontend vira roubo de sessão | Média | SEC-04 |
| 7 | Chaves de criptografia derivadas do `JWT_SECRET`; backup exportável com hashes de senha | Média | SEC-07, SEC-08 |
| 8 | Sem logs/monitoramento: ataques e falhas passam despercebidos | Média | SEC-13 |

Registro completo e mapa de calor: `10-risk-register.md` (22 riscos).

## 4. Principais oportunidades

| Oportunidade | Esforço | Ganho |
|---|---|---|
| Índice em `audit_events` + calcular só no modo demo | muito baixo | maior ganho de desempenho do sistema |
| Painel com pedidos ativos + histórico paginado | baixo | carga do banco proporcional ao trabalho do dia, não ao histórico |
| CI com os 59 testes que já existem | baixo | rede de segurança para toda a refatoração |
| Boot sem efeitos + migração como passo de deploy | baixo | elimina o maior risco operacional |
| Serviço único do ciclo do pedido | médio | uma regra em vez de três, testável |
| Vídeo 100% pela borda (já implementado, falta ligar para todas as lojas) | baixo | tira o tráfego de vídeo do Render |
| Frontend em módulos com template seguro | médio | XSS impossível por padrão e CSP viável |

## 5. Decisões tecnológicas

Manter Node/Express/PostgreSQL/Render/Cloudflare/PowerShell. **Não** recomendados: reescrita, microsserviços,
Redis, filas externas, ORM completo, troca de framework do frontend agora. Evoluções graduais: build leve do
frontend (P2), TypeScript gradual (P4), Express 5 (P5). Justificativas em `06-technology-assessment.md`.

## 6. Próximos passos (aguardando sua aprovação)

1. **Validar o ambiente** (P0-07), sem tocar em nada: confirmar no Render se existem `REPORTS_CRON_KEY`,
   `MEDIA_SECRET_KEY`, `STORE_BACKUP_KEY` (só sim/não); papel do usuário no Neon e plano de backup/PITR;
   escopo do token da Cloudflare; se há Cloudflare na frente do Render.
2. **Ambiente local isolado** com Postgres de teste (P0-01) e **CI** (P0-02).
3. **Staging** (P0-03).
4. Correções P0-04, P0-05, P0-06, uma por PR, testadas em staging antes da `main`.

Roadmap completo com critérios de aceite, testes e rollback: `08-refactoring-roadmap.md`.

## 7. Índice dos documentos

| Documento | Conteúdo |
|---|---|
| `01-project-inventory.md` | Git, stack, dependências, configuração, serviços externos |
| `02-current-architecture.md` | Parte A: engenharia reversa e 9 diagramas · Parte B: auditoria de arquitetura |
| `03-security-audit.md` | 26 achados de segurança, controles positivos, itens a validar |
| `04-code-quality.md` | qualidade, duplicação, testes, dívida técnica |
| `05-performance-scalability.md` | gargalos, índices, concorrência, escala |
| `06-technology-assessment.md` | avaliação da stack e migrações possíveis |
| `07-target-architecture.md` | arquitetura-alvo, estrutura de pastas, estratégias |
| `08-refactoring-roadmap.md` | plano P0–P5 com critérios, riscos e rollback |
| `09-file-by-file-analysis.md` | análise rastreável por arquivo |
| `10-risk-register.md` | registro consolidado de riscos |
| `progress.md` | cobertura de leitura e limitações |
