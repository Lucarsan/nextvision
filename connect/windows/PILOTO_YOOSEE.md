# Piloto real com câmera Yoosee — NextVision Connect

A versão atual do agente está descrita em
[`WINDOWS_AGENT_READINESS.md`](../../docs/WINDOWS_AGENT_READINESS.md). Ela requer
a API da branch de desenvolvimento; não executar contra a API antiga de produção.
Este roteiro mantém o modo de relay manual do primeiro piloto.

## Pré-requisitos
- Windows na rede local que alcança a câmera Yoosee, por cabo ou Wi-Fi; 2.4/5 GHz podem conviver se o roteador não isolar os dispositivos; FFmpeg, MediaMTX e Cloudflared instalados.
- Três terminais permanecem executando os comandos de retransmissão **já testados** em `docs/CAMERA_TESTE_E_AGENTE_LOJA.md`.
- Login Master no NextVision e um cadastro de câmera em uma loja (tenant).
- Loja com usuário owner e um processo com pelo menos uma etapa com câmera associada.

## Ativação do agente
1. Master → **Dispositivos** → selecione loja → **Gerar código de ativação**.
2. Em PowerShell no computador da loja, execute o arquivo `connect/windows/nextvision-connect.ps1`:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\nextvision-connect.ps1 activate
   ```
   Informe nome do computador e código temporário. O token do dispositivo fica criptografado com DPAPI do usuário Windows em `%LOCALAPPDATA%\NextVisionConnect\device-token.dpapi`.
3. Master → Dispositivos → selecione a loja → **Câmeras vinculadas ao computador** → atribua a câmera ao computador.
4. Execute em um terminal adicional:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\nextvision-connect.ps1 run
   ```
5. No painel do lojista, inicie um pedido com processo associado àquela câmera. O agente deve reportar `Gravacao iniciada`.
6. Avance/conclua a etapa. O agente para gravação e converte `.ts` para `.mp4`.
7. Localize o resultado na pasta escolhida, ou em `%LOCALAPPDATA%\NextVisionConnect\recordings\<recording_id>-<captura>.mp4`. Reproduza-o no Windows.

## Limitações críticas — protótipo, não produto final
- **Não existe upload nem download de vídeo pelo portal**: MP4 fica local; servidor marca `upload_pending` e não `ready`. Não anunciar disponibilidade para o cliente.
- **Modo manual**: exige os processos do piloto abertos. A branch nova acrescenta tarefa após login e supervisão opcional; ver `docs/WINDOWS_RUNTIME_AND_STARTUP.md`. Ainda não é um serviço antes do login nem um instalador comercial.
- **Transmissão** usa Quick Tunnel temporário, autenticado com credenciais compartilhadas. Não é infraestrutura permanente.
- **Gravação** depende da retransmissão RTSP local `rtsp://127.0.0.1:8554/camera` já ligada no modo legado. A versão nova seleciona o caminho pela câmera da tarefa e pode supervisionar fontes configuradas por câmera; preparar os caminhos do MediaMTX conforme o guia novo.
- **Fail closed**: se servidor ficar indisponível, agente encerra gravação. O operador deve rever a sequência ao recuperar a conexão.
- O encerramento de um processo FFmpeg é abrupto, por isso o agente escreve MPEG-TS primeiro e remuxa em MP4 ao final. Validar conteúdo e integridade do arquivo.
- Não distribuir ainda o script a lojas reais sem validação de controle remoto, direitos de acesso, consentimento e armazenamento protegido.
