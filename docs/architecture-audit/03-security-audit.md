# 03 — Auditoria de segurança (Fase 3)

> Análise **estática** de `develop` (= `main` @ `844b19a`). Nenhum teste dinâmico foi feito, nenhum serviço foi
> acessado e nenhum segredo foi lido. Valores de segredos nunca são reproduzidos aqui.
> Referências: OWASP Top 10 (2021), OWASP API Security Top 10 (2023), ASVS 4.0, CWE Top 25.
>
> **Status de cada achado**: **Confirmado** (comprovado pelo código) · **Suspeito** (provável, depende de
> configuração ou uso) · **Validar** (só confirmável com teste dinâmico ou acesso ao ambiente).
> A ausência de achados em uma área **não** significa que ela seja segura.

## 1. Resumo

| Severidade | Qtde | IDs |
|---|---|---|
| Alta | 3 | SEC-01, SEC-02, SEC-03 |
| Média | 11 | SEC-04 … SEC-14 |
| Baixa | 9 | SEC-15 … SEC-23 |
| Informativo | 3 | SEC-24 … SEC-26 |

**Visão geral.** O backend tem uma base defensiva melhor do que o normal para um MVP feito em poucas semanas:
SQL sempre parametrizado, isolamento por loja aplicado com consistência, tokens públicos guardados como hash,
segredos de mídia cifrados (AES-256-GCM), atualização do agente assinada (RSA-3072), uploads validados por
assinatura binária e erros que não vazam detalhes. Os riscos mais sérios estão em **identidade** (sem troca
nem redefinição de senha, sem MFA no master), na **adivinhação do link curto do pedido**, no **acoplamento do
boot com a produção** e na **falta de defesa em profundidade** (CSP, RLS, monitoramento).

### Controles positivos verificados

| Controle | Evidência |
|---|---|
| SQL parametrizado; trechos dinâmicos só de listas fixas ou chaves validadas por zod `.strict()` | varredura de todas as consultas com `${…}` em `src/` (ex.: `partners.js:33`, `store-sales.js:167`, `store-sales.js:667`) |
| Isolamento por loja: ids do corpo e da URL revalidados com `tenant_id` antes de usar | ex.: venda (`store-sales.js:1027-1063`), relatório de caixa (`:231-238`), câmeras/processos (`server.js:392-408`) |
| Sessão revalidada a cada requisição (usuário ativo, papel, loja, status) | `server.js:18-28` |
| Senhas com bcrypt custo 12; `JWT_SECRET` ≥ 32 caracteres exigido; algoritmo fixo HS256 | `server.js:13,19,166` |
| Tokens públicos e de dispositivo só como hash SHA-256 no banco | `server.js:46-53,437` |
| Segredos de mídia com AES-256-GCM | `secret-box.js` |
| Uploads: tipo por assinatura mágica, limite de tamanho, quantidade por pedido | `server.js:333-341,547-564` |
| Proxy de vídeo restrito: só nomes de arquivo HLS, só parâmetros conhecidos, sem redirecionamento, timeout e limite de 8 MB | `server.js:581-679` |
| Links salvos só com `http(s)` (bloqueia `javascript:`) inclusive na importação | `store-tools.js:16-23,215` |
| Escape de HTML presente em todos os pontos de `innerHTML` revisados por heurística | ver SEC-04 |
| Agente Windows: segredos com DPAPI, pasta só para SYSTEM/Administradores, TLS 1.2, pacotes assinados | `installer/windows/payload/FicouPronto.psm1:3-78,539-543` |
| MediaMTX só em `127.0.0.1`; leitura e playback exigem senha | `FicouPronto.psm1:242-266`, `media/docker-compose.yml` |
| Binários do instalador fixados por SHA-256 | `installer/windows/vendor.lock` |
| Histórico do Git **sem** segredos reconhecíveis (chaves de nuvem, PEM, hashes bcrypt, tokens `nvdev_`/`NV-`, URLs Postgres com senha) | varredura de `git log --all -p` |

## 2. Achados

### SEC-01 — Não há como trocar nem redefinir senha
| Campo | Valor |
|---|---|
| Categoria | A07 Identification and Authentication Failures · ASVS V2.5 · CWE-640/620 |
| Local | todo o `src/`: `password_hash` só é escrito na criação (`bootstrap.js:13`, `server.js:166`, `server.js:173`) |
| Evidência | Nenhuma rota altera `users.password_hash`. Não existe "esqueci a senha", nem troca pelo próprio usuário, nem redefinição pela central. O master cria a senha do lojista e a repassa fora do sistema. |
| Exploração | Uma senha vazada (anotada, repassada por WhatsApp, reaproveitada) não pode ser trocada. A única saída é desativar o usuário e criar outro com **outro e-mail** (`users.email` é `UNIQUE`). Para o master, nem isso existe pela interface. |
| Impacto | Alto: acesso persistente de quem obteve a senha; o master controla todas as lojas, a Cloudflare e os backups. |
| Probabilidade | Média |
| Severidade | **Alta** · Confirmado |
| Correção | Rota autenticada de troca de senha (pede a atual); redefinição pela central com senha temporária e troca obrigatória no primeiro acesso; depois, "esqueci a senha" por e-mail (Resend já integrado) com token de uso único e validade curta. |
| Complexidade | Média |

### SEC-02 — Link curto do pedido é adivinhável e dá acesso total ao pedido
| Campo | Valor |
|---|---|
| Categoria | API1 BOLA · A01 Broken Access Control · CWE-330/639 |
| Local | `server.js:802-807` (rota `/<loja>/<número>`), `sql/020_short_order_links.sql:14-38` (gerador) |
| Evidência | O número do pedido é aleatório entre 1000 e 9999 (só passa a 5 dígitos depois de 60 colisões) e único apenas entre pedidos dos últimos 365 dias. A rota procura **qualquer** pedido da loja com esse número (sem limite de data) e redireciona para `/p/<share_code>`. O slug da loja é público (QR, links). Limite: 40 tentativas a cada 10 min **por IP**, contadas na memória do processo. |
| Exploração | Uma loja com N pedidos ocupa ~N/9000 do espaço: com 1.000 pedidos, ~11% de acerto por tentativa (≈ 4 pedidos alheios a cada 10 min por IP); com vários IPs ou após um reinício, mais. |
| Impacto | O link dá o mesmo poder do link original: página do pedido (nome do pet, raça, marca/modelo, fotos, endereço e WhatsApp da loja, histórico de fidelidade), **vídeo ao vivo** do atendimento, **download das gravações** e **resgate do cupom de fidelidade** do cliente (`server.js:482-500`). |
| Probabilidade | Alta (sem pré-requisito, automatizável) |
| Severidade | **Alta** · Confirmado (lógica) · Validar em produção o volume de pedidos por loja e o IP visto pelo limitador (SEC-09) |
| Correção | O link curto deve exigir um segredo: por exemplo, `/<loja>/<número>-<4-6 caracteres aleatórios>`, ou só abrir um "resumo" sem vídeo, fotos e cupom. Limitar também por loja + número, registrar tentativas falhas e alertar. Considerar validade para links de pedidos concluídos. |
| Complexidade | Média (links já enviados por WhatsApp precisam continuar funcionando: período de transição) |

### SEC-03 — Iniciar a aplicação altera a produção (migrations, Cloudflare, timers)
| Campo | Valor |
|---|---|
| Categoria | A05 Security Misconfiguration · A08 Software and Data Integrity · NIST PR.IP-3 |
| Local | `src/start.js:9-13`, `src/server.js:579,811-812`, `src/edge-video.js:111-125`, `src/reports.js:295` |
| Evidência | `npm start` aplica as migrations pendentes no banco de `DATABASE_URL`; ao subir, o servidor publica o Worker e o domínio na Cloudflare e liga laços que **escrevem** no banco (encerrar pedidos, demo, relatórios, apagar fotos). Não há ambiente de homologação declarado; o deploy vai direto da `main`. |
| Exploração | Não é ataque: é risco operacional. Qualquer pessoa ou ferramenta que rode o projeto com um `.env` de produção (outra máquina, teste, IA) migra o banco real, republica o Worker e pode concluir pedidos de clientes. Uma migration com erro de lógica vai direto para os dados reais no próximo deploy. |
| Impacto | Alto: integridade e disponibilidade de dados de clientes reais. |
| Probabilidade | Média |
| Severidade | **Alta** · Confirmado |
| Correção | Separar "migrar" de "iniciar" (passo de pré-deploy explícito); exigir `NODE_ENV`/variável de confirmação para migrar; timers só com flag (`RUN_JOBS=true`); publicação do Worker como comando de operação; ambiente de staging com banco próprio; backup/branch do Neon antes de cada migration. |
| Complexidade | Baixa–Média |

### SEC-04 — Sem Content Security Policy; HTML montado por concatenação
| Campo | Valor |
|---|---|
| Categoria | A03 Injection (XSS) – defesa em profundidade · ASVS V14.4 · CWE-79/1021 |
| Local | `server.js:12` (`helmet({contentSecurityPolicy:false})`); ~237 `innerHTML` em `public/`; scripts inline em todas as páginas; `tracking.html:287` carrega hls.js do jsDelivr **sem SRI** |
| Evidência | Uma varredura heurística (99 trechos com campos textuais) e a revisão manual dos casos suspeitos não encontraram XSS confirmado: há escape em todos os pontos revisados. Mas a proteção depende de cada desenvolvedor lembrar o escape, e a função de escape está duplicada em 11 arquivos. Dados entram de fontes de confiança diferente: anônimo → loja (formulário do QR, `store-qr.js:33`), loja → central (chamados, nome da loja), loja → cliente (página pública). |
| Exploração | Um único escape esquecido, hoje ou numa mudança futura, permite roubar o token da sessão (`sessionStorage`) de um lojista ou do **master**. Um CDN comprometido executaria código na página pública de todos os clientes. |
| Impacto | Alto se acontecer; hoje não demonstrado |
| Probabilidade | Baixa–Média |
| Severidade | **Média** · Suspeito (sem XSS confirmado) · Validar com teste dinâmico |
| Correção | CSP com nonce, em modo report-only primeiro; mover scripts inline para arquivos; hospedar o hls.js localmente (ou usar SRI); helper único de template com escape automático. |
| Complexidade | Média |

### SEC-05 — Master sem MFA e proteção contra força bruta só por IP
| Campo | Valor |
|---|---|
| Categoria | A07 · API2 Broken Authentication · ASVS V2.2/V2.8 · CWE-307 |
| Local | `server.js:43` (12 tentativas / 15 min por IP, contador em memória) |
| Evidência | Não há bloqueio por conta, atraso progressivo, CAPTCHA nem segundo fator. O master pode criar lojas e usuários, ver todos os dados, exportar backups em JSON e mandar a Cloudflare criar túneis/DNS. |
| Exploração | Credential stuffing distribuído (muitos IPs) contra o e-mail do master ou dos lojistas. |
| Impacto | Alto (master) / Médio (loja) |
| Probabilidade | Baixa–Média |
| Severidade | **Média** · Confirmado |
| Correção | MFA (TOTP) obrigatório para master; limite por conta além de por IP; alerta de logins falhos; registrar IP e user-agent no `audit_events`. |
| Complexidade | Média |

### SEC-06 — "Senha do admin" da loja é uma só para todas as lojas
| Campo | Valor |
|---|---|
| Categoria | A07 · ASVS V2.10 (segredos compartilhados) · CWE-1391/798 |
| Local | `store-admin.js:18-25` (`STOCK_VALUE_LOGIN` / `STOCK_VALUE_PASSWORD_HASH` do ambiente) |
| Evidência | Editar/excluir produto, reajuste em lote, preço por época e valor do estoque pedem uma senha **global**. O token liberado fica preso à loja e ao usuário (`:41-47`), mas a senha é a mesma em todas as lojas, não troca por loja e não pode ser trocada sem novo deploy. Limite de 10 tentativas / 15 min por IP. |
| Exploração | Quem conhece a senha numa loja (dono, ex-funcionário) a usa em qualquer outra em que tenha login de operador, contornando a restrição pensada para operadores. |
| Impacto | Médio (preços e estoque de outra loja) |
| Probabilidade | Validar: depende de quem recebe essa senha |
| Severidade | **Média** · Confirmado (desenho) |
| Correção | Senha/PIN de admin **por loja**, guardado com hash em `tenants`, trocável pelo dono; ou usar o papel `owner` em vez de uma senha extra. |
| Complexidade | Baixa |

### SEC-07 — Chaves derivadas do `JWT_SECRET`
| Campo | Valor |
|---|---|
| Categoria | A02 Cryptographic Failures · ASVS V6.4 · CWE-320/321 |
| Local | `secret-box.js:7-13`, `store-backup.js:16-22`, `store-admin.js:43,57` |
| Evidência | Sem `MEDIA_SECRET_KEY` e `STORE_BACKUP_KEY`, as chaves de cifrar senhas de mídia e backups vêm do `JWT_SECRET` (HKDF). O mesmo segredo assina as sessões e os tokens de admin. |
| Exploração | Vazar o `JWT_SECRET` permite forjar sessão de master **e** decifrar senhas de mídia e backups de todas as lojas. Trocar o `JWT_SECRET` (resposta normal a um vazamento) torna ilegíveis as senhas de mídia e todos os backups já guardados. |
| Impacto | Alto |
| Probabilidade | Baixa |
| Severidade | **Média** · Suspeito (validar se as chaves dedicadas estão configuradas no Render) |
| Correção | Chaves independentes obrigatórias em produção (falhar o boot sem elas); identificador de versão da chave para permitir rotação; procedimento documentado de rotação. |
| Complexidade | Média |

### SEC-08 — Backup inclui hashes de senha e credenciais, e a exportação devolve tudo aberto
| Campo | Valor |
|---|---|
| Categoria | API3 Excessive Data Exposure · A04 Insecure Design · LGPD art. 46 · CWE-200/312 |
| Local | `store-backup.js:55-77` (todas as tabelas com `tenant_id`), `:154-159` (exportação), `:88-117` (restauração) |
| Evidência | O backup pega **todas** as colunas de **todas** as tabelas da loja: `users.password_hash`, `shop_devices.credential_hash`, `store_media.media_password_enc`, `shop_activation_codes`, `audit_events`, fotos em `bytea`. A exportação pelo master devolve isso em JSON legível. A restauração reinsere linhas faltantes, inclusive usuários e dispositivos apagados. |
| Exploração | Quem obtiver o JSON exportado (computador do master, e-mail, nuvem) tem hashes bcrypt para quebrar offline e dados pessoais de todos os clientes da loja. Restaurar pode **reativar** um dispositivo ou usuário removido. |
| Impacto | Médio–Alto |
| Probabilidade | Baixa |
| Severidade | **Média** · Confirmado |
| Correção | Lista explícita de tabelas e colunas no backup (excluir hashes, credenciais e auditoria); exportação sem colunas sensíveis; restauração que não reinsira `users`/`shop_devices`; registrar quem exportou e restaurou (já há `audit`). |
| Complexidade | Baixa–Média |

### SEC-09 — Rate limiting em memória, por instância, dependente do proxy
| Campo | Valor |
|---|---|
| Categoria | API4 Unrestricted Resource Consumption · CWE-770 |
| Local | `express-rate-limit` sem `store` (memória do processo) em todos os limitadores; `app.set('trust proxy',1)` (`server.js:12`) |
| Evidência | Os contadores zeram a cada deploy ou reinício e não são compartilhados entre instâncias. Com `trust proxy = 1` o IP considerado é o do último proxy. Se houver Cloudflare na frente do Render (o domínio `app.ficoupronto.com` sugere isso), o "IP" pode ser o da borda da Cloudflare: os limites ficam compartilhados entre muitos usuários (bloqueios indevidos) ou deixam de distinguir atacantes. |
| Impacto | Enfraquece SEC-02, SEC-05 e SEC-06 |
| Severidade | **Média** · Validar (cadeia de proxies em produção) |
| Correção | Confirmar a cadeia de proxies e configurar `trust proxy` de acordo (ou usar `CF-Connecting-IP` quando a origem só aceitar a Cloudflare); store persistente (Postgres) para os limites sensíveis. |
| Complexidade | Baixa |

### SEC-10 — Dados pessoais e LGPD
| Campo | Valor |
|---|---|
| Categoria | LGPD (arts. 6º, 15, 16, 18, 37, 46) · ASVS V8 |
| Local | `customers` (CPF, nascimento, endereço, telefone, e-mail), `customer_pets`, `pet_records`, `link_visits`, `audit_events` |
| Evidência | Dados pessoais em texto puro (sem cifrar CPF). Exclusão de cliente é só lógica (`deleted_at`): não há anonimização, expurgo nem prazo de retenção para clientes. Não há exportação de dados do titular. A página do cliente grava um identificador de visitante (`fp_visitor`) e mede tempo de visualização sem aviso. Google Fonts e jsDelivr recebem o IP dos visitantes. `audit_events` não guarda IP nem detalhe do acesso a dados. |
| Impacto | Regulatório e reputacional |
| Severidade | **Média** · Confirmado (técnico) · Validar com o jurídico (papéis de controlador/operador, base legal, texto de `privacidade.html`) |
| Correção | Política de retenção e rotina de anonimização; atendimento a direitos do titular (exportar/apagar); cifrar ou minimizar CPF; aviso na página pública; hospedar fontes e bibliotecas localmente; registro de acesso a dados pessoais. |
| Complexidade | Média |

### SEC-11 — Sem defesa no banco (RLS, privilégios)
| Campo | Valor |
|---|---|
| Categoria | A01 · CIS PostgreSQL · princípio do menor privilégio |
| Local | migrations (nenhuma `CREATE POLICY`/`GRANT`); `start.js` migra com o mesmo `DATABASE_URL` da aplicação |
| Evidência | O isolamento entre lojas depende só do código. O usuário da aplicação provavelmente é dono do schema (aplica DDL ao iniciar), logo um SQL injection futuro ou erro de rota teria acesso total, inclusive a `DROP`. |
| Severidade | **Média** · Suspeito (validar o papel do usuário no Neon) |
| Correção | Usuário de migração separado do usuário da aplicação (sem DDL); RLS por `tenant_id` nas tabelas de loja como segunda barreira, começando pelas mais sensíveis (`customers`, `orders`, `sales`). |
| Complexidade | Média–Alta (precisa definir `app.tenant_id` por transação) |

### SEC-12 — Token da Cloudflare com poder sobre o domínio inteiro
| Campo | Valor |
|---|---|
| Categoria | A05 · menor privilégio · gestão de segredos |
| Local | `cloudflare.js:1-8` (permissões documentadas: túnel, DNS da zona, Workers e rotas) |
| Evidência | A API do Render guarda um token capaz de criar/remover DNS e publicar Workers na zona `ficoupronto.com`. |
| Exploração | Quem obtiver as variáveis do Render (vazamento, conta comprometida) pode desviar o domínio (phishing com o domínio legítimo) ou publicar um Worker malicioso no lugar do de vídeo. |
| Severidade | **Média** · Suspeito (validar o escopo real do token) |
| Correção | Token restrito à zona e só às permissões usadas; zona separada para vídeo (ex.: só os subdomínios `video-*` e `live`); 2FA e auditoria na conta Cloudflare; segredos com acesso mínimo no Render. |
| Complexidade | Baixa |

### SEC-13 — Sem detecção: logs mínimos e sem monitoramento
| Campo | Valor |
|---|---|
| Categoria | A09 Security Logging and Monitoring Failures · NIST DE.CM |
| Local | `server.js:810` (só `err.code`/`err.name`), `audit_events` (sem IP/user-agent), logins falhos não registrados |
| Evidência | Não há ID de correlação, log estruturado, alerta, nem registro de falha de login, de tentativa de link inválido ou de 403. O único evento de segurança registrado é a senha de admin errada (`store-admin.js:56`). |
| Impacto | Um ataque como SEC-02 ou SEC-05 passaria despercebido |
| Severidade | **Média** · Confirmado |
| Correção | Log estruturado (JSON) com ID de requisição; registrar falhas de autenticação e 403/404 em rotas públicas; alertas simples (Render + serviço de logs); IP e user-agent em `audit_events`. |
| Complexidade | Baixa–Média |

### SEC-14 — Pipeline sem verificação de segurança e deploy direto da `main`
| Campo | Valor |
|---|---|
| Categoria | A06 Vulnerable Components · A08 · NIST PR.DS-6 |
| Local | `.github/workflows/` (só testes do agente Windows e o cron) |
| Evidência | Não há testes da API no CI, nem SAST, SCA (`npm audit`/Dependabot), varredura de segredos ou DAST. O Render instala com `npm install` (não `npm ci`), podendo resolver versões diferentes do lockfile se ele divergir. |
| Severidade | **Média** · Confirmado |
| Correção | CI com `npm ci`, testes de integração em Postgres de serviço, Dependabot/`npm audit`, varredura de segredos (gitleaks), CodeQL; proteger a `main` (PR obrigatório + checagens). |
| Complexidade | Baixa–Média |

### SEC-15 — Enumeração de e-mail no login
`server.js:43`: o bcrypt só roda quando o e-mail existe (resposta mais rápida para e-mail inexistente), e a
mensagem "Loja indisponível" (403) só aparece depois de uma senha correta. CWE-204/208. **Baixa** · Confirmado.
Correção: comparar com um hash fictício quando o usuário não existe; responder "Loja indisponível" antes de
validar a senha, ou com a mesma mensagem genérica.

### SEC-16 — Endpoint de cron aberto sem chave
`reports.js:283-287`: se `REPORTS_CRON_KEY` não estiver definida, qualquer pessoa pode chamar
`POST /api/internal/reports/run`. Só envia relatórios já devidos e sem duplicar (`report_runs`), mas permite
gerar carga e chamadas ao Resend. **Baixa** · Validar se a chave está configurada. Correção: exigir a chave
sempre (falhar fechado).

### SEC-17 — `share_code` guardado em texto puro
`sql/009_order_share_links.sql`: o `public_token_hash` é hash, mas o `share_code`, que dá o mesmo acesso,
fica em claro. Um vazamento do banco (backup, dump, réplica) dá acesso a todas as páginas de pedido.
CWE-256. **Baixa** · Confirmado. Correção: guardar só o hash do `share_code` e comparar pelo hash.

### SEC-18 — Formulário público do QR grava em qualquer loja
`store-qr.js:33-54`: anônimo cria cliente em qualquer loja ativa (8 por 10 min por IP, sem CAPTCHA) e pode
renomear um cliente existente cujo nome seja "placeholder". Risco de poluição de cadastro e spam.
**Baixa** · Confirmado. Correção: limite por loja, CAPTCHA leve (Turnstile, já na Cloudflare) e marcar o
cliente como "não verificado" até o primeiro atendimento.

### SEC-19 — Sessão: JWT de 8 h em `sessionStorage`, sem logout no servidor
`server.js:43`, `public/entrar.html:49`. A revalidação a cada requisição limita o dano (desativar o usuário
corta o acesso), mas um token roubado vale até 8 h e o "sair" só apaga a cópia local. **Baixa** · Confirmado.
Correção: cookie `HttpOnly; Secure; SameSite=Strict` com proteção CSRF, ou lista de revogação (`token_version`
em `users`).

### SEC-20 — Revogação do vídeo na borda depende do Render
`edge/video-worker.js` (cabeçalho), `edge-video.js:27`: o token de vídeo vale 30 min e carrega a senha de
leitura do MediaMTX (cifrada). Se o Render estiver fora do ar, o Worker não revoga e o vídeo continua até
expirar. Comportamento documentado e intencional. **Baixa** · Confirmado. Correção: validade menor (5–10 min)
com renovação, se o custo de checagem permitir.

### SEC-21 — Uploads grandes processados em memória pelo master
`store-backup.js:148` (`express.raw` com limite de 300 MB), `store-backup.js:65-77` (backup inteiro montado
em memória, com fotos). Um backup grande pode estourar a memória do serviço e derrubá-lo. **Baixa** (segurança)
/ relevante para disponibilidade (Fase 4). Correção: streaming, limite menor, fotos fora do backup ou em partes.

### SEC-22 — MediaMTX confia em qualquer conexão local
`FicouPronto.psm1:255-259`: o usuário `any` vindo de `127.0.0.1` pode publicar e usar a API. O tráfego do
túnel Cloudflare chega ao MediaMTX **como local**. Hoje é seguro porque o túnel só expõe a porta HLS (8888) e
`/get` (9996), e leitura/playback exigem senha. Se alguém expuser a API (9997) ou o RTSP no túnel, terceiros
poderão publicar vídeo falso ou mexer na configuração sem senha. **Baixa** (latente) · Confirmado. Correção:
exigir credencial também para publish/api ou restringir o `any` a um usuário de sistema.

### SEC-23 — `/health` público expõe o commit
`server.js:42`: devolve o commit em produção. Ajuda um atacante a saber qual versão está no ar. **Baixa**.
Correção: só `ok`, ou commit apenas para chamadas autenticadas.

### SEC-24 — Pacotes de atualização do agente fora do controle de versão (informativo)
`agent-releases.js:15`, `scripts/agent-release.mjs:80-88`: os pacotes são gerados localmente em
`agent-releases/`, que **nunca foi commitado**. Como o Render reconstrói o sistema de arquivos a cada deploy,
falta saber como os pacotes chegam lá. A assinatura é conferida no PC (bom), então um pacote adulterado é
recusado. **Validar** com quem opera.

### SEC-25 — Dependências (SCA estático, informativo)
Versões travadas no `package-lock.json`: express 4.22.3, body-parser 1.20.9, path-to-regexp 0.1.13, cookie 0.7.2,
send 0.19.2, qs 6.16.2, jsonwebtoken 9.0.3, jws 4.0.1, pg 8.23.1, helmet 8.3.0, zod 3.25.76; Leaflet 1.9.4;
hls.js 1.6.15. Até o meu corte de conhecimento, essas versões já incluem as correções das vulnerabilidades
públicas conhecidas dessas bibliotecas (ex.: ReDoS do path-to-regexp, cookie/send/serve-static de 2024).
`bcryptjs` 2.4.3 é antigo mas sem CVE conhecida; trunca senhas em 72 bytes. **Não** rodei `npm audit` porque
ele envia o lockfile ao registro do npm (serviço externo): **requer sua autorização**. Express 4 está em
manutenção; o Express 5 é a linha atual (avaliado na Fase 6).

### SEC-26 — Proxy HLS e SSRF (informativo)
`server.js:625` busca `config.origin`, que vem do banco (`store_media.origin`, criado pelo provisionamento com
domínio fixo, ou informado pelo **master** em `/media/adopt`) ou do ambiente. O nome do arquivo e os parâmetros
são filtrados. Não há SSRF por usuário de loja ou anônimo; um master poderia apontar a origem para um host
interno, o que é aceitável para esse papel. Sem ação além de validar o domínio na adoção.

## 3. Avaliação por área (checklist da spec)

| Área | Situação | Achados |
|---|---|---|
| **A. Autenticação** | bcrypt ok; sem troca/reset; sem MFA; força bruta só por IP; enumeração | SEC-01, 05, 15, 19 |
| **B. Autorização** | RBAC + escopo por loja consistente; BOLA por link curto; senha de admin global | SEC-02, 06, 11 |
| **C. APIs** | validação zod em todas as rotas revisadas; SQL parametrizado; sem CORS (só mesma origem); CSRF não se aplica (token em header); exposição excessiva no backup | SEC-08, 09, 16 |
| **D. Frontend** | escape presente; sem CSP; CDN sem SRI; token em `sessionStorage` | SEC-04, 19 |
| **E. Banco** | FKs (~126) e constraints; sem RLS; privilégios a validar; dados pessoais em claro; `share_code` em claro | SEC-10, 11, 17 |
| **F. Infra/DevSecOps** | HTTPS/HSTS via helmet e Render; boot altera produção; CI sem segurança; token Cloudflare amplo; logs mínimos | SEC-03, 12, 13, 14, 23 |
| **G. Privacidade** | sem retenção/anonimização de clientes; rastreio de visitante sem aviso | SEC-10 |
| **Agente/borda** | bom desenho (DPAPI, assinatura, localhost); confiança em localhost latente | SEC-20, 22, 24 |

## 4. O que precisa de validação dinâmica ou de acesso (aguarda sua autorização)

| Item | Por quê | Como, com segurança |
|---|---|---|
| Cadeia de proxies e IP visto pelo rate limit | confirma SEC-09 e o real alcance de SEC-02/05 | ler cabeçalhos numa requisição de teste a um endpoint inofensivo (`/health`), sem carga |
| Variáveis configuradas no Render (só **se existem**, não os valores) | SEC-07, SEC-16, SEC-24 | você confere no painel e me diz sim/não |
| Papel do usuário do banco no Neon | SEC-11 | você confere no painel do Neon |
| Escopo do token da Cloudflare | SEC-12 | você confere no painel da Cloudflare |
| XSS e CSP na prática | SEC-04 | ambiente **local** com banco de teste e dados fictícios |
| `npm audit` | SEC-25 | envia o lockfile ao registro do npm; só com sua autorização |
| Política de backup/PITR do Neon | recuperação de desastre | você confere o plano |
