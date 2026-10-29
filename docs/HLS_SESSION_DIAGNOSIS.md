# Diagnóstico: sessão HLS perdida no proxy

O proxy em `src/server.js` enviava `Cookie: cookieCheck=1` ao MediaMTX,
mas não mantinha um cookie jar. No MediaMTX 1.21.3, esse cabeçalho seleciona
sessões por cookie: o manifesto inicial responde 200 com `Set-Cookie` e as
referências às playlists seguintes não contêm `?session=...`. Como o proxy
descartava o cookie recebido, a playlist seguinte respondia 401 com
`{"status":"error","error":"session not found"}`. A API convertia esse erro em 502.

Isso reproduz a combinação de sintomas do piloto: o teste de curl do manifesto
inicial retorna 200 com credenciais válidas, enquanto o player falha ao continuar
a leitura. Um 200 no manifesto inicial não valida a playlist de mídia nem os
segmentos. Não foi possível confirmar os logs atuais do Render nesta sessão;
a reprodução é local, com o mesmo commit-base e MediaMTX 1.21.3.

## Correção

- Enviar `cookieCheck=1` como query **apenas** no manifesto inicial para evitar
  o redirecionamento da sondagem de cookies.
- Não enviar o cabeçalho `Cookie` ao upstream. Assim o MediaMTX usa seu fallback
  de sessão por query, já preservado pela reescrita de playlists do NextVision.
- Distinguir `session not found` de erro de senha nos diagnósticos, sem registrar
  corpos, cookies, credenciais ou identificadores de sessão.

A autenticação Basic upstream e as verificações de loja, pedido ativo, câmera,
etapa e concorrência permanecem obrigatórias em cada requisição, inclusive
segmentos. Não abrir uma câmera pública nem repassar `Set-Cookie` do MediaMTX
como solução. Uma sessão na query não substitui a autorização do pedido.

Referências oficiais da versão usada:

- [Seleção de sessão e sondagem de cookies](https://github.com/bluenviron/mediamtx/blob/v1.21.3/internal/servers/hls/http_server.go)
- [Cookie versus query da sessão](https://github.com/bluenviron/mediamtx/blob/v1.21.3/internal/servers/hls/session.go)
- [Recuperação da sessão, caminho e IP](https://github.com/bluenviron/mediamtx/blob/v1.21.3/internal/servers/hls/server.go)

## Teste de regressão

`test/live-media.integration.test.js` usa o servidor NextVision de verdade,
PostgreSQL em um schema descartável, MediaMTX 1.21.3 e FFmpeg com vídeo sintético
H.264. Gera credenciais de teste e certificado TLS local; o certificado é
explicitamente confiado, sem desativar a verificação TLS. Nenhuma câmera real,
banco de produção ou credencial de produção é necessária.

Pré-requisitos: Node.js >=20, dependências npm do projeto, PostgreSQL local,
FFmpeg/ffprobe, OpenSSL e o binário oficial do MediaMTX. Verificar o SHA-256 do
arquivo da distribuição contra o `checksums.sha256` da mesma release antes de
usar o binário. Definir com segurança `TEST_DATABASE_URL` para o PostgreSQL local
e `MEDIAMTX_BINARY` para o caminho absoluto do executável. Não registrar valores
de conexão em documentação, comandos compartilhados ou logs.

No diretório do repositório:

```sh
node --test test/live-media.integration.test.js
npm run check
```

Sem as duas variáveis, a integração é marcada como **skipped**, não como
validação concluída. O teste cria e remove somente seu schema temporário;
não executa nem modifica as migrações ou dados da aplicação.

Para incluir o navegador, disponibilizar Playwright e definir
`BROWSER_EXECUTABLE` para Chromium e `HLS_JS_PATH` para uma cópia de
`hls.js@1.6.15/dist/hls.min.js`. A suíte carrega a página e os metadados reais,
acompanha 60 segundos de reprodução e verifica que pausar o pedido remove o
player e bloqueia novas requisições de vídeo. Sem essas variáveis, somente esse
subteste fica skipped. Na execução completa desta investigação: **7 testes
passaram, 0 falharam, 0 skipped**.

Cobertura:

1. Reproduz no MediaMTX real o 200 inicial seguido de 401 por sessão perdida
   quando se anuncia suporte a cookies sem conservar o cookie.
2. Verifica 200 do manifesto, playlist e segmentos via API, preservação de
   `session`, ausência de URL upstream/credenciais na playlist e decodificação
   de segmentos H.264 que avançam no tempo.
3. Rejeita token inválido e acesso de outra loja.
4. Bloqueia dois pedidos ativos concorrentes na mesma câmera.
5. Retira acesso em pausa/conclusão, inclusive a playlists/segmentos já obtidos,
   e ao mudar para outra câmera, excluir o pedido ou suspender a loja.

## Limites da validação

Esta correção foi validada em reprodução local com vídeo sintético, inclusive
no portal real pelo Chromium durante 60 segundos. O teste não inclui o túnel
Cloudflare nem a câmera Windows; não equivale a confirmar o vídeo real no portal
de produção. A falha SQL da migração 008 é um problema independente
do schema de instalação e não foi alterada nesta investigação.

No piloto atual, MediaMTX, o FFmpeg publicador e cloudflared ainda dependem de
processos locais. Fechar as janelas pode interrompê-los; não presumir que ficaram
ativos. Ao retomar um teste real, confirmar os processos atuais, iniciar MediaMTX
antes da publicação FFmpeg e confirmar o endereço vigente do Quick Tunnel.
Não reutilizar PIDs ou URLs efêmeras históricos. O script Connect de gravação
não inicia nem supervisiona esses três programas.

Critério final em produção: pedido ativo com manifesto e segmentos 200 via proxy,
imagem em movimento no portal por 30–60 segundos e retirada do acesso na
pausa/troca de câmera/conclusão. Isso ainda precisa ser verificado após o deploy.
