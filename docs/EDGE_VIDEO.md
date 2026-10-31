# Vídeo ao vivo pela borda (Cloudflare Worker)

## Por quê
Antes, todo byte de vídeo passava pelo Render (proxy em `/api/public/orders/:token/live/*`), com
2 consultas ao banco por pedaço de vídeo. O Render cobra a banda que sai dele; a Cloudflare não cobra
a banda do Worker. O Worker roda perto do cliente (Fortaleza/São Paulo), então cada requisição do
LL-HLS deixa de ir aos EUA.

```
antes:  celular → Cloudflare → Render (EUA) → Cloudflare → túnel → MediaMTX da loja
agora:  celular → Worker (Cloudflare, perto) → túnel → MediaMTX da loja
```

## Como funciona
1. A página do cliente pede `GET /api/public/orders/:token/live-source`.
2. Se a loja está liberada (`EDGE_VIDEO_TENANTS`) e o Worker foi publicado, o Render responde
   `{mode:'edge', url:'https://live.ficoupronto.com/v/<token>/index.m3u8'}`; senão, `{mode:'proxy'}`.
3. `<token>` é AES-256-GCM com `EDGE_VIDEO_KEY`: origem da loja, câmera, senha de leitura do MediaMTX,
   token do pedido e validade (30 min). O cliente não lê nem altera. Vai no caminho do link, então o
   HLS nativo do iPhone funciona; as referências relativas da playlist herdam `/v/<token>/`.
4. O Worker (`edge/video-worker.js`) abre o token, só aceita origens `*.ficoupronto.com`, busca no
   túnel com a senha e repassa os segmentos em fluxo.
5. Revogação: nas playlists, o Worker pergunta `POST /api/edge/live-check` (cache de 15 s por link).
   Pausou, concluiu ou trocou de câmera → 403 em até ~15 s. Se o Render estiver fora do ar, o vídeo
   continua até a validade do link.

## Nada muda no PC da loja
O MediaMTX continua com a mesma senha de leitura. Instalador e piloto não precisam de atualização.

## Ativar
1. Token da Cloudflare (o mesmo `CLOUDFLARE_API_TOKEN`): acrescentar **Account → Workers Scripts → Edit**
   e **Zone → Workers Routes → Edit** (ficoupronto.com).
2. No Render: `EDGE_VIDEO_KEY` (gerar com o comando do `.env.example`), `EDGE_VIDEO_HOST=live.ficoupronto.com`,
   `EDGE_VIDEO_TENANTS=lojateste`.
3. Ao subir, o Render publica o Worker `ficoupronto-video` e o domínio `live.ficoupronto.com`.
   Conferir: `GET /api/master/edge-video` (central) → `state: "publicado"`. Republicar: `POST /api/master/edge-video/publish`.
4. Validar no celular (4G, Android e iPhone). Depois ampliar `EDGE_VIDEO_TENANTS`.

Voltar atrás: apagar `EDGE_VIDEO_TENANTS` (ou deixar vazio) → tudo volta ao proxy, sem deploy de código.

## Custos
Workers grátis: 100 mil requisições/dia. LL-HLS faz várias por segundo por espectador; com ~10 lojas
ativas pode ser preciso o Workers Paid (US$ 5/mês, 10 milhões inclusos). Medir no painel da Cloudflare.
