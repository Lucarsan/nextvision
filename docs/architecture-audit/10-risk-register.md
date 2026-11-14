# 10 — Registro consolidado de riscos

> Escalas: Probabilidade e Impacto de 1 (muito baixo) a 5 (muito alto). Exposição = P × I.
> Situação: **Aberto** (nenhuma ação iniciada). Todos os riscos dependem da aprovação do roadmap.

| ID | Risco | Origem | P | I | Exp. | Mitigação (roadmap) | Dono sugerido | Situação |
|---|---|---|---|---|---|---|---|---|
| R-01 | Rodar o projeto com variáveis de produção altera o banco e a Cloudflare reais | SEC-03, ARQ-01 | 3 | 5 | **15** | P0-01, P0-03, P0-04 | Tech lead | Aberto |
| R-02 | Acesso a pedidos de terceiros (vídeo, fotos, gravações, cupom) por link curto adivinhado | SEC-02 | 4 | 4 | **16** | P0-05, P1-10 | Tech lead | Aberto |
| R-03 | Senha vazada sem possibilidade de troca (inclusive master) | SEC-01 | 3 | 5 | **15** | P0-06, P1-08 | Tech lead | Aberto |
| R-04 | Migration com erro aplicada direto em produção sem staging nem testes no CI | SEC-03, SEC-14 | 3 | 5 | **15** | P0-02, P0-03, P0-04 | Tech lead | Aberto |
| R-05 | Página pública e painel ficam lentos ou derrubam o banco com o crescimento (`audit_events`, polling) | PERF-01, PERF-02 | 4 | 3 | **12** | P1-01, P1-02 | Dev | Aberto |
| R-06 | Conta master comprometida por força bruta/credential stuffing | SEC-05, SEC-09 | 2 | 5 | **10** | P1-08, P1-10 | Tech lead | Aberto |
| R-07 | Vazamento do `JWT_SECRET` compromete sessões, senhas de mídia e backups; rotação quebra dados | SEC-07 | 2 | 5 | **10** | P0-07, P1-05 | Tech lead | Aberto |
| R-08 | XSS futuro sem CSP rouba sessão de lojista/master | SEC-04 | 2 | 5 | **10** | P1-06, P2-05 | Dev | Aberto |
| R-09 | Não conformidade com a LGPD (retenção, direitos do titular, rastreio sem aviso, CPF em claro) | SEC-10 | 3 | 3 | **9** | P2-07 | Jurídico + Tech lead | Aberto |
| R-10 | Backup grande estoura memória e derruba a API para todas as lojas | PERF-05, SEC-21 | 2 | 4 | **8** | P1-07 | Dev | Aberto |
| R-11 | Exportação de backup expõe hashes de senha e dados pessoais | SEC-08 | 2 | 4 | **8** | P1-07 | Tech lead | Aberto |
| R-12 | Bug de isolamento entre lojas sem segunda barreira no banco | SEC-11 | 2 | 5 | **10** | P2-04 | Tech lead | Aberto |
| R-13 | Token Cloudflare permite desviar o domínio se o ambiente do Render vazar | SEC-12 | 1 | 5 | **5** | P0-07 (escopo) | Ops | Aberto |
| R-14 | Ataque ou falha passa despercebido por falta de logs e alertas | SEC-13 | 4 | 3 | **12** | P3-06, P1-08 | Ops | Aberto |
| R-15 | Regras do ciclo do pedido divergem entre rota, auto-close e demo | ARQ-02 | 3 | 3 | **9** | P1-03 | Dev | Aberto |
| R-16 | Refatoração quebra telas do caixa (arquivos de 316 KB, testes acoplados ao HTML) | QLD-06/07 | 3 | 4 | **12** | P0-02 antes de tudo; PRs pequenos; staging | Dev | Aberto |
| R-17 | Senha de admin global conhecida por várias lojas | SEC-06 | 3 | 2 | **6** | P2-06 | Dev | Aberto |
| R-18 | Atualização remota do agente indisponível (pacotes fora do Git/disco efêmero) | SEC-24 | 3 | 2 | **6** | P0-07 | Ops | Aberto |
| R-19 | Perda de dados sem recuperação por plano de backup do Neon desconhecido | Fase 3 §4 | 2 | 5 | **10** | P0-07 (confirmar PITR), snapshot antes de migrations | Ops | Aberto |
| R-20 | Custo de banco elevado por consultas contínuas (demo a cada 4 s) | PERF-03 | 3 | 2 | **6** | P3-01 | Ops | Aberto |
| R-21 | Dependência de uma única pessoa/ferramenta de IA para entender o sistema | Fase 1 (README obsoleto) | 4 | 3 | **12** | esta auditoria; P4-05 | Tech lead | Aberto |
| R-22 | Disco do computador de desenvolvimento cheio (C:) interrompe ferramentas | observado nesta sessão | 4 | 1 | 4 | liberar espaço; usar E: para temporários | Usuário | Aberto |

## Mapa de calor

| Impacto ↓ / Prob. → | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| **5** | R-13 | R-06, R-07, R-08, R-12, R-19 | R-01, R-03, R-04 | — |
| **4** | — | R-10, R-11 | R-16 | R-02 |
| **3** | — | — | R-09, R-15 | R-05, R-14, R-21 |
| **2** | — | — | R-17, R-18, R-20 | — |
| **1** | — | — | — | R-22 |
