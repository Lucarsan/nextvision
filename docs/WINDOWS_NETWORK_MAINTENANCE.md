# Redes principal, reservas e manutenção pelo agente

Recurso implementado na branch de desenvolvimento do agente completo. Não foi
instalado no supervisor separado do piloto e ainda requer validação da interface
e das APIs WLAN em um PC Windows. Não anunciar o instalador comercial concluído.

## Tela de manutenção

O modo `nextvision-connect.ps1 configure-network` abre uma janela local com:

- Adaptador Wi-Fi e rede principal.
- Até oito redes de reserva, com inclusão, remoção e alteração de prioridade.
- Conexão e teste do perfil selecionado; em falha, solicita retorno ao perfil
  anterior quando identificado e disponível.
- Acesso à configuração nativa do Windows para adicionar uma rede, alterar sua
  senha ou configurar segurança empresarial; atualizar a lista depois.
- Opção explícita de troca automática, habilitada somente após testar a rede
  principal e cada reserva contra os endereços das câmeras configuradas.

A seleção de principal/reservas leva o botão de teste para o perfil selecionado.
O teste muda a conexão do PC e pode interromper temporariamente o vídeo. A
aprovação verifica alcance TCP dos endereços/portas, não a identidade física da
câmera, autenticação NVR nem qualidade de vídeo. A instalação técnica também deve
confirmar os feeds e links autorizados de todas as câmeras. Ao alterar fontes ou
roteamento, reabrir a tela e testar novamente os perfis.

Não é necessário estar conectado ao servidor para abrir a manutenção: ela usa
as fontes já protegidas e vinculadas no computador ativado. Alterar a conexão
Windows não altera fonte NVR, plano, cota ou autorização de câmeras na central.

As senhas Wi-Fi continuam no armazenamento de perfis do Windows. O programa não
exporta chaves em texto, não escreve senha Wi-Fi em JSON/XML, nem passa senha em
argumentos. A tela usa os perfis salvos; o cadastro e a edição de senhas usam a
interface nativa do Windows. A configuração local `network-policy.json` contém
identificador do adaptador, nomes de perfis, ordem, testes e hosts/portas das
câmeras, sem URLs com credenciais. JSON é lido explicitamente em UTF-8 para
preservar SSIDs com acentos no Windows PowerShell 5.1.

## Recuperação automática

A troca é opcional. O agente verifica a política **antes** das chamadas à central,
para que a perda da rede não impeça sua própria recuperação. A API nativa WLAN
controla apenas o adaptador selecionado, usando perfis escolhidos pelo operador.
Não procura senhas nem entra em outras redes salvas arbitrariamente.

Três observações sem conexão antecedem a primeira tentativa. O agente tenta a
principal, depois as reservas na ordem definida, aguarda até 20 segundos por
conexão/alcance e aplica intervalos entre tentativas. Após percorrer a lista,
aguarda antes de um novo ciclo. Uma reserva funcionando permanece conectada;
o agente não força retorno à principal durante o atendimento.

Se já está numa rede selecionada e conectada, mas a câmera fica inacessível,
registra esse problema sem ficar alternando Wi-Fi: a câmera pode estar sem
alimentação. Se o PC é levado para uma rede não selecionada e sem alcance local,
a política automática tenta restaurar os perfis escolhidos. A tela e o agente
usam uma trava para não disputar mudanças durante manutenção manual.

A consulta usa APIs WLAN nativas, sem interpretar saída localizada do netsh.
Permissões de Wi-Fi/localização do Windows 11 podem impedir identificar o perfil
ativo. Nesse caso a troca automática é suspensa e a interface pede revisão das
permissões, sem declarar conexão validada. Adaptador desativado, política
corporativa ou perfil removido também exigem manutenção. O código não ativa
rádio desabilitado fisicamente, altera roteador ou ignora restrições do Windows.

O teste em execução é limitado a até três endpoints por ciclo, evitando bloquear
indefinidamente a consulta de autorização enquanto muitas câmeras estão offline.
O estado `rede com acesso a camera` significa que há ao menos um endpoint
alcançável; a saúde de cada publicador continua sendo monitorada separadamente.

## O que as redes de reserva precisam oferecer

2,4 GHz e 5 GHz podem acessar as mesmas câmeras quando pertencem à rede local com
comunicação permitida. Nome/faixa de Wi-Fi não comprova essa comunicação.
Os perfis de reserva precisam alcançar a instalação da loja por uma topologia
preparada: por exemplo, pontos de acesso da mesma LAN ou uma conexão gerenciada.

Mudar a conexão do computador não muda automaticamente o Wi-Fi de uma câmera
Yoosee. Se o roteador/rede da câmera for substituído ou desligado e ela perder a
conexão, é necessário reconectá-la pelo procedimento suportado pelo fabricante.
A câmera e a rede da loja precisam de energia e conectividade para transmitir.
Este módulo não implementa reconfiguração remota do Wi-Fi interno das câmeras,
VPN, redundância de roteador/ISP ou descoberta de câmera que mudou de IP.

A operação do painel em outra rede permanece independente: o operador pode usar
celular/PC remoto enquanto o agente de captura permanece conectado na loja.

## Verificação e aceite pendente

`connect/windows/tests/network.tests.ps1` exercita validação, prioridade de
reservas, retentativas, câmera offline sem alternância desnecessária, retomada de
perfil selecionado, suspensão por perfil desconhecido, trava manual e remoção
de credenciais dos endpoints. O teste injeta observação/conexão/sondagem simuladas:
não muda Wi-Fi nem comprova a interface WLAN de um Windows real.

O workflow Windows executa esses cenários em PowerShell 5.1 e 7 junto dos testes
de tarefas/DPAPI. Antes de distribuir, validar a janela e estes cenários reais:

1. Adicionar perfil no Windows, escolhê-lo e testar cada câmera/vídeo.
2. Substituir principal e reservas depois da instalação, inclusive sem internet.
3. Derrubar o AP principal mantendo um caminho para as câmeras via reserva.
4. Trocar 2,4/5 GHz e Wi-Fi/cabo sem reintroduzir senhas NVR ou exigir F5.
5. Desligar uma câmera sem provocar alternância de redes saudáveis.
6. Trocar a rede/roteador da câmera pelo fabricante e refazer o vínculo de rede.
7. Verificar comportamento quando o Windows nega consulta do perfil ou conexão.

O instalador assinado e a interface comercial de lançamento ainda estão pendentes.
A manutenção já pode ser chamada pelo modo do agente; o atalho do instalador final
precisa abrir esta mesma tela.
