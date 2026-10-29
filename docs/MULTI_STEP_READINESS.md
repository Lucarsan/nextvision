# Primeira base para pedidos com várias etapas

## Comportamento implementado

A migração `014_order_process_snapshot.sql` preserva nome, etapas e configuração
de câmeras dentro de cada pedido. A cópia é feita por trigger no banco, no mesmo
INSERT que cria o pedido, com bloqueio compartilhado do processo de origem.
Pedidos comuns, rápidos e integrações que insiram pedidos passam pela mesma regra.
A definição copiada e a associação pedido/processo/loja são imutáveis.

Editar um processo passa a valer para novos pedidos, inclusive quando existem
pedidos em andamento. Pedidos na fila, em atendimento e concluídos continuam
usando sua própria definição. Listagem da loja, rastreio público, transições,
autorização HLS e notificações consultam a cópia do pedido.

Uma etapa pode herdar a câmera padrão, escolher outra câmera da mesma loja ou
selecionar explicitamente **Sem câmera nesta etapa**. A última opção é diferente
de herdar o padrão; não agenda captura nem libera HLS nessa etapa. O portal
informa a ausência de câmera sem tentar iniciar um player.

As gravações são identificadas por pedido, índice da etapa e visita. Pausa/retomada e retorno a uma etapa criam novos identificadores de captura. Os testes
verificam separação dos jobs, finalização ao avançar, conclusão somente na última
etapa, estados de pausa/retomada e rejeição de notificações incompatíveis.

## Instalação e atualização

Foi corrigido o delimitador SQL inválido da migração 008. O runner executa
as migrações novas, registradas em uma tabela de versões, numa transação e serializa execuções simultâneas por banco/schema.
Se houver falha, ocorre rollback e o comando retorna erro. Reexecutar as migrações
não atualiza as cópias dos pedidos já preservados.

Antes de iniciar a nova API, no diretório do repositório e com as credenciais do
banco carregadas de forma segura:

```sh
npm run db:migrate
npm start
```

O servidor novo exige a coluna criada pela migração 014. Não publicar a API sem
planejar a migração anterior ao início dessa versão. Esta alteração não executa
migrações nem modifica dados no Neon/Render por conta própria.

Na primeira migração de pedidos existentes, a cópia usa a definição do processo
disponível naquele momento. Etapas já alteradas antes dessa migração não podem
ser reconstruídas automaticamente. Preservar backup e revisar esse histórico
antes de aplicar em produção.

## Validação

Com `TEST_DATABASE_URL` apontando para PostgreSQL local:

```sh
node --test test/order-steps.integration.test.js
```

A suíte cria um schema descartável, aplica migrações reais e opera a API por HTTP.
Inclui atualização de um pedido legado concluído, repetição de migrações,
pedidos comuns/rápidos, edição do processo, fluxo de três etapas com duas câmeras
e uma etapa sem câmera, pausa/retomada, eventos atrasados, isolamento por loja e
arquivamento. Não usa nem altera o banco de produção.

Com Playwright disponível e `BROWSER_EXECUTABLE` configurado para Chromium,
também testa o painel real criando, salvando e recarregando a opção sem câmera.
A suíte HLS descrita em `HLS_SESSION_DIAGNOSIS.md` deve acompanhar a validação.
Um teste skipped não conta como comportamento validado.

## Pendências antes do instalador comercial

- **Arquivos de gravação no Windows:** a continuação agora recebe um novo job/UUID,
  evitando reutilizar o caminho do trecho anterior. Ainda é necessário consolidar
  as partes, reconciliar falhas e validar esse ciclo com o agente no Windows antes
  de anunciar um único MP4 completo para download.
- **Várias câmeras no agente:** o protótipo ainda lê o caminho RTSP fixo
  `camera`, mesmo quando os jobs referenciam câmeras diferentes. O agendamento
  correto no servidor não substitui esse mapeamento local.
- **Gravação rápida:** se um atendimento inteiro começar e terminar entre dois
  polls, o agente pode não capturar nada. Falta confirmação de captura e uma
  mensagem explícita para gravações não realizadas.
- **Download:** não há entrega remota de MP4, armazenamento online ou protocolo
  de acesso aos arquivos locais da loja. Não marcar `upload_pending` como `ready`.
- **Operação:** aplicativo Windows, seleção persistente do diretório, conexão
  estável, supervisão dos processos e atualização automática ainda precisam ser
  implementados e validados.

Esta entrega prepara a consistência das etapas e o agendamento no servidor.
Não afirma gravação MP4 completa, várias câmeras físicas funcionando nem produto
empacotado.

Para os fluxos operacionais, planos, controle de câmeras e implantação das migrações 015–018, consulte `STORE_OPERATIONS_AND_CAMERA_PLANS.md`.
