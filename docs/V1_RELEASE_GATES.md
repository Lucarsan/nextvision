# Gates para a v1.0 comercial do agente

O portal e o agente têm entregas distintas. Publicar código web/SQL não gera um
instalador Windows nem provisiona uma infraestrutura de mídia.

| Área | Evidência atual | Gate restante |
| --- | --- | --- |
| Portal/API/banco | Pedidos completos, ações na mesma aba, polling, clientes, nichos, fila privada, cotas e permissões; teste de upgrade 13→18 | Confirmar revisão implantada e aceite do usuário na produção |
| Agente do piloto | DPAPI e tarefa após login; queda controlada do FFmpeg recuperou vídeo no Windows/cliente sem F5 | Migrar ao serviço e ao pacote final sem processos duplicados |
| Instalador | Scripts/módulos versionados | `.exe`/instalador assinado, dependências verificadas/licenças, instalação/reparo/remoção, atualização e rollback |
| Execução contínua | Supervisão de publicadores/relay e conector nomeado em desenvolvimento | Serviço antes do login, conta/ACL/cofre adequados e testes de reboot, logout e recuperação |
| Rede | Tela de principal/reservas, perfis do Windows e testes automatizados da política | Aceite real WLAN/GUI, cabo↔Wi-Fi e 2,4↔5 GHz com vídeo ativo |
| Mídia comercial | Piloto por Quick Tunnel; caminhos por câmera no banco/agente | Origem permanente, publicação autenticada por dispositivo/câmera, revogação, várias lojas e capacidade de rede |
| Gravações | Arquivos TS/MP4 locais, pasta selecionável, visitas preservadas | Consolidação/recuperação, entrega protegida, estados corretos e retenção acordada |
| Download com PC desligado | Não implementado | Cópia externa e armazenamento/entrega durável; arquivo somente local não atende esse caso |
| Operação técnica | Atribuição de técnico, ativação de dispositivo, cotas, incluir/trocar/remover câmeras | Ensaio completo com várias câmeras físicas e troca pós-instalação |
| Cobrança | Limites/estados manuais e solicitação por WhatsApp | Provedor, webhooks, reconciliação, avisos e bloqueio/liberação automatizados |

Não marcar v1.0 somente por empacotar o script em `.exe`. Validar produto instalado,
rede, mídia, autorização e arquivos em condições reais. O provedor de pagamento,
o serviço de mídia permanente e a estratégia de armazenamento externo ainda
precisam ser definidos/provisionados. Uma v1 de cobrança manual ou sem cópia
externa exige declarar explicitamente essas limitações no escopo comercial.

## Instalação e faixas Wi-Fi

A câmera usa as faixas que o modelo suporta. Um modelo somente 2,4 GHz permanece
nessa faixa; modelos dual-band/5 GHz usam sua configuração própria. O PC pode usar
5 GHz ou cabo desde o começo, desde que tenha comunicação com a câmera pela LAN.

Fluxo técnico previsto:

1. Conferir energia, roteador/LAN, isolamento de clientes e faixas dos modelos.
2. Conectar cada câmera à rede suportada, pelo procedimento do fabricante,
   habilitar a interface de vídeo suportada e configurar credencial própria.
   O pareamento pode exigir temporariamente um celular/PC em 2,4 GHz conforme
   o modelo; isso não obriga o PC de captura a permanecer nessa faixa.
3. Reservar endereços no DHCP ou preparar endereçamento estável, sem conflitos.
4. Autenticar o técnico/dispositivo e vincular as câmeras aprovadas pela central.
5. Testar alcance, autenticação e quadros reais de todas as câmeras com o PC na
   conexão diária pretendida, inclusive 5 GHz/cabo.
6. Salvar/testar principal e reservas do PC; todas precisam de um caminho até as
   câmeras. O perfil Wi-Fi salvo no Windows não altera permissões do roteador nem
   reconecta automaticamente o Wi-Fi interno de uma câmera após trocar o SSID.
7. Instalar serviço/pacote final, validar reinício e operações de pedidos/etapas,
   e entregar a loja somente com critérios de aceite cumpridos.

O operador pode abrir o painel por outra rede ou internet móvel. O agente de
captura permanece na loja ou usa uma conexão gerenciada com ela. Se o equipamento
que recebe RTSP sair para uma rede sem rota até a câmera, salvar a senha Wi-Fi
não cria esse caminho.
