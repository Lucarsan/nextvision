# NextVision — registro do teste de câmera e instalador da loja (28/10/2026)

## Resultado efetivamente observado
- Câmera Yoosee LEY-19 com NVR/ONVIF habilitado.
- Na rede de teste, RTSP foi acessível no IP privado `192.168.1.13`, porta `554`, caminho `/onvif1`, usuário `admin`; **a senha NVR nunca deve ser registrada no Git**.
- A câmera respondeu a `ffplay -rtsp_transport udp`; a tentativa com `-rtsp_transport tcp` retornou `400 Bad Request`.
- O fluxo observado pelo ffprobe: vídeo HEVC/H.265, 1920×1080, 15 FPS; áudio PCM A-law 16 kHz mono.
- Houveram perdas RTP/UDP, `missed packets` e quadros HEVC inválidos. Transcodificação para H.264 720p/15 fps melhorou a fluidez, **não resolveu a perda no trecho Wi-Fi câmera → notebook**.
- Windows FFmpeg 9.0.2 e MediaMTX 1.21.3 receberam/publicaram vídeo no caminho local `camera`; HLS local abriu em `http://127.0.0.1:8888/camera/`.
- MediaMTX requer arquivo `%USERPROFILE%\mediamtx.yml`; exemplo de configurações efetivamente testado: listener RTSP `127.0.0.1:8554`, HLS `127.0.0.1:8888`, `paths.camera.source=publisher`, autorização local exclusivamente para `publish` e usuário separado com senha para `read`/`playback`.
- Testes HLS: requisição local sem credenciais ao manifesto deu 401; por Cloudflare Quick Tunnel sem credenciais deu 401 e com autenticação Basic de usuário dedicado deu 200. Isso **não equivale a auditoria de segurança**.
- Cloudflared 2026.10.5 conectado via QUIC e subdomínio temporário `trycloudflare.com`, não estável e não apropriado à operação definitiva. Não registrar URL efêmera em documentação operacional como se fosse fixa.
- Render registrou deploy Live no commit `be66121653afc8f7efafde43f76d1515f4b0319a`. Backend tem proxy HLS por pedido; **vídeo em produção dentro de pedido ainda não foi confirmado de ponta a ponta**.

## Pipeline de teste que funcionou
```powershell
# Terminal A: servidor local (com mediamtx.yml configurado)
mediamtx
# Terminal B: substitua SUA_SENHA somente na máquina da loja (não compartilhe)
ffmpeg -hide_banner -loglevel warning -rtsp_transport udp -i "rtsp://admin:SUA_SENHA@192.168.1.13:554/onvif1" -map 0:v:0 -an -vf "scale=1280:720,fps=15" -c:v libx264 -preset ultrafast -tune zerolatency -b:v 1200k -pix_fmt yuv420p -f rtsp -rtsp_transport tcp "rtsp://127.0.0.1:8554/camera"
# Terminal C (apenas teste de túnel gratuito)
cloudflared tunnel --url http://127.0.0.1:8888
```
Nunca publique acesso HLS sem controle de acesso. Senha NVR já apareceu em conversa; usuário deve trocá-la.

## Requisitos para o agente NextVision de Windows
1. Instalador simples, instalação por loja com **código de ativação único/expirável** emitido pelo painel; armazenar hash do token no Neon, não o segredo.
2. Serviço residente sem janelas PowerShell, inicia com Windows, monitora FFmpeg/MediaMTX/cloudflared, religa em falhas e registra diagnósticos (com segredos ocultos).
3. Descoberta de câmeras na LAN, teste RTP/RTSP de codec, configuração de IP/porta/caminho/usuário e senha NVR salva criptografada pelo DPAPI Windows. Não armazenar senha no Neon.
4. Por câmera: ativo/inativo controlado pelo painel, polling autenticado com token próprio revogável; nenhuma informação de outra loja.
5. Bind específico de câmera e etapa; revogação deve impedir publicação e reprodução; operador precisa registrar auditoria.
6. Nuvem: substituir Quick Tunnel por endereço estável e autenticado, com disponibilidade e limite de escala avaliados. O Quick Tunnel atual não serve como canal gerenciado permanente.
7. Lidar com NAT, queda de Wi-Fi, codec, CPU, bitrate e qualidade; preservar credenciais apenas localmente; empacotamento Windows e assinatura digital futura.
8. Não liberar vídeo globalmente aos clientes; política vinculada ao pedido e janela de etapa. Não começar/gravar por padrão sem autorização.

## Estado: não confundir com implementação
O teste manual do notebook foi concluído. O provisionamento automatizado e o bloqueio pelo painel ainda requerem implementação, revisão e teste em Windows real.
