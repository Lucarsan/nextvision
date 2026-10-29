# Operação da loja, fila e controle central de câmeras

## Pedidos e clientes

- A aba Pedidos cria pedidos com cliente, item (veículo/aparelho/outro), marca,
  modelo, placa/série, cor, serviço e observações internas. Permite cadastrar e
  selecionar o cliente no mesmo formulário, sem sair da página.
- Listas exibem detalhes e ações de iniciar, pausar, retomar, avançar, voltar e
  excluir. Excluir durante atendimento arquiva o pedido, bloqueia seu link/HLS
  imediatamente e agenda a finalização das capturas. Arquivos locais não são
  apagados por essa ação; o agente observa a instrução no próximo polling.
- Retornar etapa ou retomar cria uma nova visita de gravação com novo UUID.
  Isso evita reutilizar o nome de arquivo do trecho anterior. Não implica MP4
  consolidado nem download implementado: as partes ainda precisam de entrega.
- Ações da interface incluem o estado/etapa esperado. Requisições atrasadas ou
  duplicadas não pulam etapas silenciosamente.
- Visão Geral mostra todos os pedidos, sem limite de 12, com busca, seletor
  compacto de situação e ordenação. O padrão visual é mais recentes primeiro.
- A fila real atende por ordem de chegada, com prioridade manual. Pedidos novos
  entram ao final; não confundimos a fila de atendimento com a lista de recentes.
- Dados são consultados a cada cinco segundos enquanto o painel está visível,
  e ao retomar foco. A atualização altera as listas sem recriar os formulários
  ou apagar rascunhos. Criar um pedido atualiza a lista imediatamente.
- Clientes aparecem como registros de leitura, com pesquisa e edição em diálogo.
  Cadastro e importação CSV continuam disponíveis, sem formulários de edição
  permanentemente abertos na lista.

## Cliente final e privacidade da fila

O link individual mostra a posição entre os pedidos aguardando daquela loja e
as fases dos atendimentos em execução. Posição 1 significa o próximo da fila;
atendimentos em execução aparecem separadamente e podem ser simultâneos.
Prioridade manual e exclusão alteram a posição; pedidos excluídos não contam.
Um pedido pausado antes de iniciar sai da fila até ser retomado.

O resumo de outros atendimentos contém somente fase, número da etapa, total de
etapas e situação. Não inclui identidade, número de pedido, item, contato, links
ou vídeo de outro cliente. Observações internas e detalhes do item são restritos
ao painel da loja. O rastreio consulta atualizações a cada 15 segundos.

O player tenta se reconectar quando a origem falha, sem exigir F5. Isso inclui
erro inicial, término inesperado e ausência de progresso de quadros enquanto o
pedido continua ativo. Pausa manual do player não dispara o monitor de progresso.
Ao pausar/finalizar/excluir, a API bloqueia HLS e a página destrói o player.
Reconectar o player não reinicia o publicador FFmpeg no computador da loja.

## Central, técnicos e planos

- Nicho é configurado pela central. Novas lojas recebem um processo inicial
  correspondente; o lojista não recebe um catálogo de nichos de outras lojas.
  Alterar o nicho não reescreve processos ou pedidos existentes.
- A central controla estado da loja e `camera_limit` (1–128). O banco serializa
  cadastros para impedir estouro do limite por chamadas concorrentes.
  Câmera bloqueada ainda ocupa vaga; remoção lógica libera vaga e preserva FKs,
  histórico e gravações. Reduzir o plano abaixo do instalado é rejeitado.
- Lojistas não cadastram, alteram, removem ou vinculam câmeras. Podem utilizar
  as câmeras liberadas na sua configuração de processos e nos próprios pedidos.
- Técnicos alteram apenas lojas com atribuição `assigned`/`in_progress`.
  Após concluir, nova manutenção precisa ser reautorizada pela central, usando
  a mesma atribuição; não exige recriar a loja ou apagar o histórico.
- Central/técnico autorizado podem incluir, bloquear, trocar ou remover câmera.
  Troca conserva o identificador lógico/caminho, aumenta a versão da configuração
  e mantém a transmissão bloqueada até a liberação do equipamento substituto.
  O indicador de instalação não substitui um teste real de imagem.
- Trocar o computador responsável fecha a captura anterior. Só o dispositivo
  original confirma a finalização desse arquivo; o novo recebe sua configuração.
- Estado/atividade da conta e situação da loja são verificados em cada chamada
  autenticada. Bloquear uma loja revoga o uso mesmo com sessão anterior aberta;
  HLS, links públicos e dispositivos também validam o estado da loja.
- `Meu plano` informa o limite e câmeras instaladas, permite escolher a quantidade
  desejada e abre o WhatsApp comercial configurado pela central. A solicitação
  não libera capacidade automaticamente. O contato vem de `/api/master/settings`;
  sem número configurado, o link fica indisponível e a interface informa isso.

Os indicadores financeiros da central refletem as faturas registradas. A
automação de pagamentos, avisos programados e suspensão/liberação financeira
**aguarda definição e integração do provedor de cobrança**. Não há confirmação
de pagamento, disparo de mensagens ou assinatura comercial automatizada nesta
entrega. Liberação de acesso e capacidade continuam sob controle da central.

## Vários caminhos de vídeo

Cada câmera tem `stream_path` único e `config_version`. O dispositivo consulta
`GET /api/connect/cameras` e recebe somente câmeras atribuídas a ele, sem senhas
NVR. O lojista não recebe caminhos internos nem credenciais da infraestrutura.

O piloto continua compatível com `LIVE_CAMERA_ID` e o caminho `/camera`.
O roteamento central de várias câmeras requer explicitamente
`MEDIA_MULTI_CAMERA_ENABLED=true`, `LIVE_CAMERA_ID` ausente e uma origem de mídia
central HTTPS autenticada. A API resolve o caminho pela câmera autorizada na
etapa do pedido; não aceita escolher URL/câmera arbitrária pelo navegador.

**Essa opção não instala infraestrutura de mídia.** Antes de habilitar o modo
central em produção, provisionar a origem estável, autenticação de publicação
por dispositivo/câmera e o agente Windows que configura cada fonte local em seu
caminho aprovado. O agente passou a configurar fontes e supervisionar FFmpeg por câmera aprovada;
continua publicando no relay local, agora com gerenciamento opcional de MediaMTX
e conector de túnel nomeado. A origem estável e a ingestão por loja exigem
provisionamento externo. Ver `WINDOWS_AGENT_READINESS.md` e
`WINDOWS_RUNTIME_AND_STARTUP.md`.
Vários equipamentos físicos e ingestão de várias lojas exigem esses passos e
validação real; caminhos distintos no servidor não bastam.

## Migração e publicação

Aplicar migrações 014–018 antes de servir a nova API. O runner mantém uma tabela
de versões (`nextvision_schema_migrations`) para executar cada arquivo uma vez,
com transação e lock. Isso evita recriar a antiga restrição de gravação única por
etapa depois que já existem várias visitas. O primeiro uso do runner atualizado
adota instalações antigas executando as migrações idempotentes anteriores.

Fazer backup e planejar uma janela de manutenção: a API antiga não pode continuar
gravando com a restrição antiga depois da migração de visitas. Não publicar
somente o frontend ou somente o backend. Campos e tabelas novos são obrigatórios.
Histórico anterior à migração 014 só pode ser inicializado com o processo
disponível naquele momento; mudanças históricas já perdidas não são reconstruídas.

## Verificações disponíveis

- `test/order-steps.integration.test.js`: histórico, migrações e visitas por etapa.
- `test/store-operations.integration.test.js`: detalhes privados, ordenação,
  exclusão ativa, FIFO/reordenação, acesso central e limite de seis câmeras sob
  requisições concorrentes.
- `test/store-panel.integration.test.js`: navegador desktop/mobile, cadastro
  inline, filtros sem limite, ações na aba Pedidos, preservação de rascunhos,
  clientes, central, WhatsApp e visão anônima da fila.
- `test/camera-lifecycle.integration.test.js`: autorização técnica, caminhos
  distintos, troca de computador, encerramento da captura e manutenção.
- `test/live-media.integration.test.js`: MediaMTX real autenticado, H.264
  decodificável, 60 segundos no navegador, falha inicial e reinício real do
  publicador, além de bloqueios de acesso. `TEST_MEDIA_MODE=central` inclui uma
  segunda fonte com resolução diferente para comprovar a seleção do caminho.

Testes usam PostgreSQL local, schemas descartáveis e vídeo sintético. Fornecer
`TEST_DATABASE_URL`, `MEDIAMTX_BINARY`, `BROWSER_EXECUTABLE` e `HLS_JS_PATH`
conforme a suíte. `TEST_HLS_ENGINE=hlsjs` exercita o fallback MSE/HLS.js;
o padrão usa o suporte nativo do Chromium quando disponível. Teste skipped não
conta como validação. Nenhuma mensagem real de WhatsApp é enviada pelos testes.
