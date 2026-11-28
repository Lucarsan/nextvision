# Acesso só no computador da unidade

Pedido da Audace em 28/11/2026: quem tem a senha não pode entrar de qualquer lugar pelo link. Com a trava ligada, só entra quem está **num PC de unidade com o Ficou Pronto instalado e ativado**.

## Como funciona

```
Navegador (audace.ficoupronto.com/acesso)
  1. POST /api/auth/unit (ou /api/auth/login)      → 403 code=device_required
  2. POST http://127.0.0.1:47833/proof             → ponte local do agente (ficoupronto-bridge.ps1)
       ponte → POST /api/connect/login-proof        (credencial nvdev_ do PC, que nunca sai dele)
       ← { proof } (uso único, vale 2 minutos)
  3. Repete o login com device_proof               → sessão com o ID do PC (dev)
```

- **A trava é por unidade** (`tenants.device_lock`). Ligada numa unidade, o caixa e os logins da própria loja (gerente, operador) só abrem no PC **daquela** unidade. As outras unidades não mudam.
- **Trava da gestão** (`store_networks.device_lock`): dono e supervisores só entram num PC de **qualquer** unidade da rede.
- **Só liga com PC ativado**, na unidade e, para a gestão, em pelo menos uma unidade da rede. Isso evita derrubar quem ainda não instalou o programa. Em 28/11 a trava da rede inteira foi ligada com só Sobral instalado e as outras 6 unidades saíram do sistema; por isso a trava passou a ser por unidade.
- **Central e técnico nunca são travados.**
- **Sessões:** ao ligar a trava, quem estava conectado fora de um PC válido sai na hora. Se um PC for revogado, a sessão aberta nele também cai.
- **Senha continua obrigatória.** A prova sozinha não abre nada.
- **Tentativas recusadas** ficam registradas (`audit_events.action = 'device_lock_denied'`) e aparecem na central.

## Ponte local (agente 0.7.0)

- O agente abre `ficoupronto-bridge.ps1` e vigia o processo a cada 10 s. A ponte termina junto com o agente.
- Escuta só em `127.0.0.1:47833`, portanto não fica acessível pela rede da loja.
- Responde só a páginas `https://*.ficoupronto.com` e ao endereço próprio da rede, que vem de `/api/connect/login-origins`.
- Envia os cabeçalhos de CORS e `Access-Control-Allow-Private-Network` para o Chrome. O Chrome pode pedir **uma vez** a permissão de "acessar apps deste dispositivo": **permitir**, pelo RustDesk, na instalação.
- Log: `C:\ProgramData\FicouPronto\logs\ponte-local.log`.

## Ligar para uma rede

1. Em cada PC de unidade, instalar o Ficou Pronto 0.7.0 ou mais novo (instalador leve, "só gestão") e ativar com o código gerado na central para **aquela loja**. Num PC que já tem o agente, mande a atualização 0.7.0 pela central.
2. Abrir uma vez `https://audace.ficoupronto.com/acesso` nesse PC e entrar, para o Chrome liberar a ponte.
3. Na central, em Redes → (rede) → "Acesso só no computador da unidade", clicar em **Ligar** na linha da unidade. Testar o caixa no PC dela e tentar entrar de outro lugar, que tem que ser recusado.
4. Depois de instalar em todas as unidades, ligar a **trava da gestão**, se a rede quiser.
5. Para trocar ou perder um PC: clicar em "Revogar" e ativar o novo com um código novo. Com a trava ligada, o caixa só volta a abrir com outro PC ativado. Em caso de emergência, clicar em **Desligar** na unidade.

## Limites

- A sessão do quiosque fica no navegador do PC. Quem tem acesso de administrador ao Windows e conhecimento técnico consegue copiar o token (16 h) para outro computador. A trava impede o uso da senha fora dos PCs, mas não protege contra o administrador do próprio PC.
- Se o agente estiver parado, ninguém entra naquele PC. Ver o sinal de vida em Monitoramento, ou desligar a trava temporariamente.

## Arquivos

- `sql/104_device_lock.sql`, `src/device-lock.js`, login em `src/server.js` e `src/kiosk.js`, sessão no `auth` de `src/server.js`.
- `public/device-proof.js` (usado em `acesso.html` e `entrar.html`), cartão na central em `public/central-networks.js`.
- `installer/windows/payload/ficoupronto-bridge.ps1` e o trecho de vigilância em `ficoupronto-agent.ps1`.
- Testes: `test/device-lock.integration.test.js` e `test/device-lock-panel.integration.test.js` (Chrome, com a ponte simulada).
