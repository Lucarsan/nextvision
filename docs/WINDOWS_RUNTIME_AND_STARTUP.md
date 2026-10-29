# Inicialização automática e serviços locais

Branch de desenvolvimento, ainda sem publicação em produção. Requer a API e as
migrações descritas em `WINDOWS_AGENT_READINESS.md`. Não substituir o piloto que
está transmitindo antes da publicação compatível e do teste Windows.

## Funcionamento

`configure-runtime` habilita o gerenciamento opcional do MediaMTX 1.21.3. O agente
inicia uma instância própria com RTSP TCP em `127.0.0.1:8554`, HLS autenticado em
`127.0.0.1:8888` e API de controle autenticada em `127.0.0.1:9997`. Os protocolos
não usados ficam desligados. Só fontes locais configuradas, autorizadas e
habilitadas geram caminhos no relay. Novos caminhos e remoções usam a API do
MediaMTX, preservando o relay e as outras câmeras; mudanças de equipamento e
computador continuam exigindo uma nova fonte local aprovada.

O arquivo `services/mediamtx.generated.json` não contém senhas nem caminhos
coringa. Credenciais são entregues pelo ambiente privado do processo, com chaves
indexadas suportadas pelo MediaMTX 1.21.3. Variáveis herdadas `MTX_*`, `RTSP_*` e
`TUNNEL_*` são removidas dos filhos antes de aplicar os valores aprovados; o proxy
e a confiança de certificados herdados são preservados. A API do relay usa uma
senha aleatória por execução, diferente da senha de leitura. Não há leitura HLS
anônima, inclusive em loopback: o túnel também chega pelo endereço local.

O agente verifica se já há serviços nas portas necessárias e recusa assumir
um serviço externo. A autenticação de controle comprova a disponibilidade de sua
instância. A saída do processo ou falha de saúde leva a nova tentativa em 2–60
segundos. Ao reiniciar o relay, encerra as capturas dependentes e preserva os
arquivos, reportando falha em vez de anunciar gravação completa; não promete uma
gravação sem lacunas após falha de infraestrutura. A perda de conexão/autorização
com a API da central encerra todos os processos gerenciados no próximo ciclo.

Um túnel nomeado pode ser supervisionado separadamente. Uma queda apenas do
conector permite continuar a gravação local enquanto o agente tenta reconectar.
O endpoint `/ready`, em `127.0.0.1:49312`, confirma conexões do conector Cloudflare;
isso **não comprova** o hostname, a rota HTTP, a senha HLS nem o vídeo no navegador.
Sem conectividade por 60 segundos, o processo é reiniciado com retentativa. O token
fica no arquivo DPAPI do usuário e no ambiente do processo, fora dos argumentos e
do arquivo gerado de configuração. Logs brutos dos filhos não são publicados.

## Configuração técnica

Primeiro ativar o dispositivo, vincular câmeras na central, configurar a leitura
local, as fontes por câmera e a pasta de gravação pelo guia do agente. Em seguida,
com os arquivos `.ps1` e os três módulos `.psm1` na mesma pasta:

```powershell
.\nextvision-connect.ps1 configure-runtime
```

Esse modo pede login da central ou de um técnico com manutenção aberta e o caminho
do MediaMTX. Aceita apenas 1.21.3, versão validada com a API dinâmica. FFmpeg deve
estar no PATH durante a configuração; seu caminho absoluto é salvo para não
depender do PATH da tarefa no próximo login. A configuração fica em
`%LOCALAPPDATA%\NextVisionConnect\runtime-config.dpapi`.

Na primeira migração do piloto manual, o técnico deve encerrar os processos
antigos que identificou e verificar as portas. O agente não mata processos por
nome nem reaproveita PIDs de testes anteriores. Para voltar ao gerenciamento
externo, sem apagar fontes, credenciais ou vídeos:

```powershell
.\nextvision-connect.ps1 external-runtime
```

O próximo ciclo encerra os serviços que o agente iniciou. O relay externo deve
ser preparado pelo técnico antes de voltar a atender pedidos.

## Túnel fixo opcional

A central precisa provisionar um **túnel nomeado gerenciado remotamente**, um
hostname fixo e a rota para o HLS local `http://127.0.0.1:8888`, com o acesso da API
à origem preparado. O programa não cria conta, domínio, DNS ou rotas Cloudflare e
não atualiza sozinho a origem cadastrada no backend.

Depois da preparação, o técnico executa:

```powershell
.\nextvision-connect.ps1 configure-tunnel -TunnelHostname 'video.exemplo.com'
```

O login técnico é verificado; o token é solicitado ocultamente dentro do programa.
Não incluir token no comando nem enviá-lo pelo chat. `cloudflared` deve estar no
PATH; `-CloudflaredPath 'C:\pasta\cloudflared.exe'` permite informar um caminho.
Trocar o token/hostname reinicia somente o conector, preservando o relay e as
fontes. O programa entrega o token com `TUNNEL_TOKEN`, usa `--no-autoupdate` e um
arquivo de configuração próprio para evitar assumir um `config.yml` externo.

Quick Tunnels `*.trycloudflare.com` continuam disponíveis no piloto manual, mas
são rejeitados no gerenciamento permanente, pois o endereço pode mudar. Não
transformar um endereço temporário em fixo copiando-o para a configuração.

Esta integração de túnel permanece uma opção do piloto. A arquitetura comercial
com várias lojas ainda requer ingestão central com autorização de publicação por
dispositivo/câmera. O backend atual tem uma origem global de mídia; configurar
vários túneis locais não implementa automaticamente origens diferentes por loja.
Também não entrega o isolamento pretendido guardar no PC administrado pelo
lojista as credenciais de uma origem HLS pública direta: na arquitetura central,
as credenciais de leitura ficam na central e o dispositivo recebe somente a
permissão de publicação. A restrição de planos/links na API continua valendo, mas
um administrador local pode alterar o software e ler segredos em memória.

## Início automático no Windows

Depois da configuração, instalar e iniciar:

```powershell
.\nextvision-connect.ps1 install-startup
```

O programa copia os arquivos para `NextVisionConnect\app\<versão>` e registra uma
tarefa por SID do usuário Windows, com privilégio limitado e sem armazenar senha
de login. A tarefa usa a mesma identidade que protegeu os arquivos DPAPI, inicia
o agente oculto **depois do login desse usuário** e permite operação com a tela
bloqueada. Não é um serviço que inicia antes do login. Políticas do Windows
podem restringir o registro da tarefa; a instalação deve ser validada pelo técnico.

A tarefa ignora instâncias duplicadas; o agente também mantém um arquivo com
trava exclusiva. Encerramentos inesperados permitem até três reinícios com um
minuto de intervalo; a recuperação normal de rede e dos filhos ocorre dentro do
próprio agente. Instalar uma atualização preserva a instância atual; a nova cópia
vale no próximo início. Planejar a troca fora de uma gravação em andamento.

Comandos de operação:

```powershell
.\nextvision-connect.ps1 status
.\nextvision-connect.ps1 stop
.\nextvision-connect.ps1 start
.\nextvision-connect.ps1 uninstall-startup
```

`stop` persiste a intenção de parada, desabilita a tarefa e solicita encerramento
normal, aguardando até 30 segundos antes de parar a tarefa. Não força o encerramento
de um PowerShell manual desconhecido. `start` limpa a solicitação, reabilita e
inicia a tarefa registrada. `uninstall-startup` remove a tarefa e preserva vídeos,
fontes e credenciais. Uma execução manual explícita de `run` limpa a solicitação
de parada; o modo de segundo plano respeita essa intenção. O status exibe estados
observados e seu horário: uma observação antiga não prova que o agente esteja ativo.

## Evidência e limites

O laboratório `test/windows-agent.integration.test.js` usa PowerShell 7 no Linux,
MediaMTX 1.21.3 real e duas fontes FFmpeg sintéticas. Além da supervisão de
publicadores, valida autenticação, recusa de serviço externo já na porta, adição e
remoção sem interromper a outra câmera, reinício real do relay e limpeza dos
filhos. A remoção é conferida na API de caminhos e pela negação do HLS; MediaMTX
1.21.3 pode retornar 500 enquanto fecha o muxer removido. O proxy NextVision
aplica sua própria autorização antes de consultar a origem.

O conector é um executável local **simulado**, que valida os argumentos, o token
no ambiente e as respostas de prontidão. O teste provoca saída e perda de saúde;
não cria túnel nem comprova conexão real com Cloudflare. Domínio e token não estão
configurados neste ambiente.

`connect/windows/tests/startup.tests.ps1` registra e remove uma tarefa isolada no
Windows, conferindo identidade, cópia estável, trava e intenção de parada sem
conectar o agente à produção. Integra o workflow Windows junto de DPAPI/Job Object,
em PowerShell 5.1 e 7. Esse workflow ainda precisa ter seu resultado confirmado;
registro da tarefa em CI não comprova execução após login no PC do lojista.

Continuam pendentes o teste real no Windows/Yoosee, a validação do túnel nomeado,
a interface técnica integrada, o instalador assinado, a ingestão comercial de
múltiplas lojas e upload/download. Sem cópia externa, o computador desligado não
fornece download dos vídeos locais.
