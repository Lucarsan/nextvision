# Recuperação do vídeo no piloto existente

## Diagnóstico confirmado em 29/10/2026

No PC do piloto, MediaMTX e cloudflared estavam ativos, mas não havia FFmpeg.
Após religar FFmpeg, ele permaneceu aberto com CPU praticamente parada e sem
conexões estabelecidas com câmera/relay. Os testes HLS sem senha retornaram 401
localmente e pelo túnel; isso comprova resposta HTTP, não entrega de vídeo.
A leitura autenticada local retornou 404. Por fim, o teste de
`192.168.1.13:554` no Windows retornou `TcpTestSucceeded: False` e
`DestinationHostUnreachable`, com origem `192.168.1.5` na interface Wi-Fi.

A câmera abre no Yoosee e continua mostrando o IP 192.168.1.13. O aplicativo pode
usar conectividade pela internet; isso não comprova alcance direto do PC pela
LAN. O usuário confirmou que o PC estava em outro Wi-Fi; o Windows também mostrou
a vizinhança ARP de 192.168.1.13 como `Unreachable`, MAC zerado. A etapa pendente
é conectar o PC à rede local da câmera e comprovar alcance RTSP antes de
confirmar recuperação do vídeo. Não concluir que o vídeo foi restaurado
apenas porque o processo reapareceu. Não há evidência de senha NVR inválida.

## Correções compatíveis com a API publicada

Esta branch parte de f932969 e não exige migrações novas, o agente multi-câmera
ou o endpoint ainda não publicado `/api/connect/cameras`.

- `tracking.html`: retentativa após falha inicial, encerramento e falta de
  progresso. A recuperação da origem deve retomar o vídeo sem F5. Autorização por
  pedido/etapa e remoção do player na pausa/conclusão continuam obrigatórias.
- Transições de pedido: reserva transacional por câmera, inclusive entre pedidos
  diferentes. Duas solicitações simultâneas resultam em um pedido ativo e outro
  preservado na fila; retomar/avançar para câmera ocupada não modifica o pedido
  nem encerra a captura anterior. O HLS continua negando dados legados em conflito.
- `nextvision-pilot.ps1`: supervisor separado, restrito ao piloto manual de uma
  câmera. Protege a fonte NVR com DPAPI, entrega credenciais por stdin ao FFmpeg,
  detecta saída e 45 segundos sem progresso, e tenta recuperar em 2–60 segundos.
  O RTSP tem timeout de entrada; logs brutos são descartados, persistindo apenas
  categorias fixas. O processo aberto sem quadros deixa de permanecer invisível.

O supervisor pode iniciar o MediaMTX com **o arquivo autenticado original** se
não houver listener em 8554. Não assume nem mata MediaMTX/cloudflared externos e
não modifica esse YAML. Não cria um Quick Tunnel novo: isso mudaria a origem e
exigiria atualização da central. O hostname fixo/ingestão comercial ainda precisa
ser provisionado. O código não resolve falta de alimentação ou isolamento de rede.

## Instalação do supervisor no Windows

Baixar os três arquivos da mesma revisão, verificando SHA-256 antes de executar:
`NextVision.Core.psm1`, `NextVision.Startup.psm1`, `nextvision-pilot.ps1`.
Não precisa substituir o servidor ou configurar o agente completo.

Na sessão em que a senha NVR já foi pedida como SecureString e o FFmpeg manual
foi iniciado com `Start-Process -PassThru`, a instalação pode usar esses objetos:

```powershell
.\nextvision-pilot.ps1 repair -CameraPassword $nvSenha -PublisherToReplace $nvPublisher
```

A fonte padrão é `rtsp://192.168.1.13:554/onvif1`, usuário `admin`, transporte UDP
e saída local `/camera`, específicos do piloto. Informar `-CameraAddress` e
`-Transport` se o técnico confirmar outra configuração. Sem senha fornecida, o
programa solicita credencial em diálogo na primeira configuração. Não colocar
senha literal em comandos. `MediaMTXPath` e `MediaMTXConfig` permitem informar
os caminhos originais caso estejam fora do padrão WinGet/perfil do usuário.

O programa registra a tarefa por SID, copia os três arquivos para uma pasta
estável e inicia em segundo plano após login do mesmo usuário Windows. Uma
falha no registro não encerra o FFmpeg manual. Somente o objeto de processo
fornecido na instalação pode ser substituído; não reutilizar PIDs históricos.
A tarefa não inicia antes do login. Uma política do Windows pode exigir que o
técnico ajuste as permissões para registrar a tarefa.

Dados ficam em `%LOCALAPPDATA%\NextVisionPilotRecovery`. A senha permanece em
`source.dpapi`, protegida para o usuário. `status.json` contém somente horário,
estado e PID do publicador pertencente ao supervisor. Ele detecta o agente
completo e encerra o piloto para evitar publicação duplicada. Para migrar ao
agente completo, interromper/remover esta tarefa durante a instalação técnica.

```powershell
.\nextvision-pilot.ps1 status
.\nextvision-pilot.ps1 stop
.\nextvision-pilot.ps1 start
.\nextvision-pilot.ps1 uninstall
```

Um teste explícito pode solicitar a interrupção controlada **somente do filho
FFmpeg mantido pelo supervisor**, verificando sua recuperação:

```powershell
.\nextvision-pilot.ps1 restart-publisher
```

Esse teste interrompe momentaneamente o vídeo; executá-lo em um pedido de teste
com a recuperação da página já publicada. Confirmar novos quadros no cliente por
30–60 segundos e revogação ao pausar/concluir. Não anunciar recuperação enquanto
`192.168.1.13:554` continuar inacessível.

## Validação

`test/live-media.integration.test.js` usa API real, PostgreSQL local isolado,
MediaMTX autenticado por TLS e vídeo FFmpeg sintético. Inclui manifesto, playlist,
segmentos decodificáveis, falha inicial, 60 segundos no navegador, queda real e
retomada sem F5; roda tanto HLS nativo como HLS.js. Também cobre a disputa
simultânea de pedidos por câmera e a preservação do vídeo do pedido autorizado.

`test/windows-agent.integration.test.js` verifica fontes UDP/TCP, encerramento e
travamento reais, reinício dos publicadores, separação dos vídeos e gravações sem
sobrescrita. PowerShell 7 no Linux valida essa lógica; não comprova DPAPI, tarefas
Windows, Yoosee ou a rede real. `core.tests.ps1` e `startup.tests.ps1` no workflow
Windows incluem DPAPI, Job Object, registro/remoção de tarefa e entrada específica
do piloto. O resultado Windows deve ser confirmado antes de anunciar instalação
comprovada. Nenhum teste usa banco, câmera ou credenciais de produção.

Não há upload/download novo neste reparo. Cópia externa, interface/instalador
comercial e ingestão central por dispositivo/câmera continuam separados.
