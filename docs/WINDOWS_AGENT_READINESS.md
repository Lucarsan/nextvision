# Agente Windows: fontes por câmera e gravação local

Implementação na branch de desenvolvimento. **Não executar esta versão no piloto
em produção antes de publicar a API compatível e suas migrações 014–018.** A API
atual de produção pode ainda não ter `/api/connect/cameras`.

## O que esta versão faz

- Consulta somente câmeras atribuídas ao dispositivo ativado. Cada fonte local é
  associada ao ID e à versão de vínculo aprovados pela central.
- Permite à central ou ao técnico com atribuição aberta configurar/remover uma
  fonte local. O lojista não recebe essa autorização pelo login owner/operator.
- Guarda fontes RTSP, senha NVR, token e senha de leitura com DPAPI do usuário
  Windows. Não envia senha NVR ao servidor. O FFmpeg recebe a fonte por stdin via
  concat, sem credenciais nos argumentos; diagnósticos brutos são descartados.
- Supervisiona os publicadores FFmpeg que ele próprio iniciou, com reinício após
  saída ou 45 segundos sem progresso. Retentativas usam espera de 2 a 60 segundos.
  Progresso local não comprova reprodução no navegador do cliente.
- Encerra publicadores/capturas quando a consulta remota falha, a câmera é
  desabilitada/removida ou o vínculo muda. A detecção depende da próxima consulta:
  normalmente 5 segundos, podendo acrescentar os timeouts HTTP de 10 segundos.
- Separa as capturas pelo `camera_id` de cada tarefa. Pausa, retorno e nova visita
  usam os IDs distintos emitidos pela API. Arquivos TS e MP4 nunca são sobrescritos.
- Permite escolher a pasta de novas gravações. Mantém arquivos antigos em sua
  localização original; gravações já abertas terminam na pasta em que começaram.
- Mantém eventos não confirmados em disco e registra capturas abertas. Após
  encerramento inesperado, preserva os arquivos e reporta falha, sem anunciar
  gravação completa. Não retoma nem concatena automaticamente uma captura perdida.
- Impede duas instâncias para o mesmo usuário Windows. Usa Job Objects do Windows
  para encerrar seus filhos quando o agente termina, inclusive após falha do pai.
  Não procura nem mata FFmpeg/MediaMTX/cloudflared externos pelo nome.

A versão do vínculo (`config_version`) muda em troca de equipamento/computador.
Renomear, atualizar o estado de teste ou desabilitar/reativar temporariamente
preserva a fonte salva. Uma troca exige nova configuração para impedir que a
credencial do equipamento anterior seja reutilizada silenciosamente.

## Preparação técnica

Usar Windows PowerShell 5.1+ e FFmpeg no PATH, sempre com o mesmo usuário Windows.
Manter `nextvision-connect.ps1` e `NextVision.Core.psm1` na mesma pasta. O usuário
do Windows e um administrador local conseguem alterar o programa ou inspecionar
memória: DPAPI não transforma um computador administrado pelo lojista em ambiente
inviolável. Limites e acesso público continuam sendo impostos pelo servidor.

O gerenciamento opcional de MediaMTX e túnel nomeado, junto do início automático,
está em [`WINDOWS_RUNTIME_AND_STARTUP.md`](WINDOWS_RUNTIME_AND_STARTUP.md). No
modo externo/legado, configurar
RTSP local em `127.0.0.1:8554`, HLS autenticado e os caminhos aprovados. A publicação
local do agente não usa credencial e deve ser permitida **somente em loopback e
nos caminhos aprovados**, sem permitir leitura anônima. Não liberar HLS anônimo
por ser loopback: o túnel também chega ao MediaMTX a partir de loopback.

Não habilitar várias lojas em produção com Quick Tunnels e credencial global:
a origem estável e a autenticação de ingestão por dispositivo/câmera ainda
precisam ser provisionadas. O modo `central_media` resolve caminhos, mas este
agente publica apenas no relay local; não implementa envio RTSP direto à central.

## Operação

Os comandos abaixo são executados na pasta dos dois arquivos. São modos do
programa, sem colar prompts interativos e comandos subsequentes juntos.

```powershell
.\nextvision-connect.ps1 activate
```

A central gera o código, ativa o computador e vincula as câmeras a ele no painel.
Depois informar a credencial de **leitura do MediaMTX**, diferente da senha NVR:

```powershell
.\nextvision-connect.ps1 configure
```

Para escolher a pasta em uma janela nativa:

```powershell
.\nextvision-connect.ps1 set-storage
```

Alternativa sem seletor:

```powershell
.\nextvision-connect.ps1 set-storage -RecordingDirectory 'D:\Videos NextVision'
```

Conferir IDs e autorização, sem mostrar credenciais:

```powershell
.\nextvision-connect.ps1 status
```

Para cada câmera vinculada, usar o ID exibido. O programa pede login técnico uma
vez, endereço RTSP sem credenciais, transporte e credencial NVR em diálogos.
Yoosee do piloto usa entrada UDP. Configurar a fonte mesmo que esteja desabilitada
para teste; a habilitação posterior mantém a versão do vínculo.

```powershell
.\nextvision-connect.ps1 configure-camera -CameraId 'ID-DA-CAMERA'
```

Depois executar uma única instância:

```powershell
.\nextvision-connect.ps1 run
```

Antes de assumir a publicação, encerrar manualmente somente o publicador antigo
da mesma câmera. O agente não assume processos que já estavam abertos. O modo
legado permite continuar gravando o relay `/camera` iniciado manualmente, quando
não há fonte configurada pelo agente; nesse caso não supervisiona esse publicador.
Em `central_media`, uma câmera sem fonte local configurada fica sem captura.

Para trocar câmera: marcar substituição na central, configurar nova fonte no
mesmo ID e habilitar após teste. Para remover o equipamento do sistema, remover
na central/técnico; o próximo polling encerra a fonte. Para apagar apenas a
configuração local, preservando cadastro/histórico:

```powershell
.\nextvision-connect.ps1 remove-camera -CameraId 'ID-DA-CAMERA'
```

Esse modo deixa um marcador local de desativação, inclusive no piloto legado;
uma nova configuração técnica remove o marcador. Pastas padrão e estado local
ficam em `%LOCALAPPDATA%\NextVisionConnect`. `runtime.json` guarda somente IDs,
estados e horário da última observação; uma observação antiga não comprova que o
agente esteja rodando. Não compartilhar arquivos DPAPI nem logs antigos do piloto.

## Verificação e pendências

`connect/windows/tests/core.tests.ps1` verifica roteamento, rejeição de injeção,
pasta com espaços/Unicode, preservação e escrita atômica, argumentos e retentativa.
Em Windows acrescenta DPAPI e Job Object. O workflow `windows-agent.yml` executa
esse conjunto em Windows PowerShell 5.1 e PowerShell 7; a existência do workflow
não comprova que uma execução remota tenha passado.

`test/windows-agent.integration.test.js` usa PowerShell 7 no Linux, MediaMTX real
e dois FFmpeg sintéticos, com entradas UDP e TCP. Verifica publicadores concorrentes, saída inesperada,
travamento real por SIGSTOP com a outra câmera em movimento, troca de fonte,
remoção, encerramento e TS/MP4 H.264 com a cor correta de cada câmera. Executar
em laboratório isolado, com porta 8554 livre, `PWSH_BINARY` e `MEDIAMTX_BINARY`
apontando para binários oficiais verificados. Não usa câmera, senha, banco ou
pedido de produção. Um teste skipped não conta como validação.

Ainda pendem validação no PC Windows do piloto (DPAPI, Job Object, rede Yoosee,
pasta escolhida, execução após login e duas câmeras físicas), túnel nomeado real,
interface técnica integrada e instalador assinado. A tarefa de início automático
e a supervisão opcional de MediaMTX/cloudflared foram implementadas; a execução
específica no Windows ainda precisa ser confirmada. A infraestrutura comercial
de ingestão para múltiplas lojas continua pendente.

**Não há upload/download pelo portal.** MP4 fica no PC do lojista; finalização
bem-sucedida deixa a tarefa em `upload_pending`. Se o computador estiver desligado,
o vídeo local não poderá ser baixado. A cópia externa para disponibilidade
independente e a política de retenção ainda precisam ser implementadas.
