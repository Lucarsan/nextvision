// Manual do sistema da rede (Audace), por função. Aparece no menu Treinamento.
// - seller: vendedora (quiosque, com PIN). supervisor: painel da rede, unidades dele. owner: gestão (rede toda).
// - Supervisor e gestão também veem as páginas da vendedora (precisam saber o que ela faz no caixa).
// - Mudou uma página de forma que todos precisem ler de novo? Suba a "version" dela.
// Blocos: h (título do tópico), p (texto), steps (passo a passo), list (itens), tip (dica), warn (cuidado), img + cap (print).
const ALL = ['seller', 'supervisor', 'owner'], LEAD = ['supervisor', 'owner'], OWNER = ['owner'];

export const MANUAL_GROUPS = [
  { key: 'caixa', title: 'Quiosque: o dia a dia da vendedora' },
  { key: 'rede', title: 'Painel da rede: supervisão' },
  { key: 'gestao', title: 'Gestão da rede' }
];

export const MANUAL_PAGES = [
  // ======================= VENDEDORA (quiosque) =======================
  {
    key: 'v-entrar', group: 'caixa', version: 1, audiences: ALL, title: 'Entrar na unidade e abrir o caixa',
    summary: 'Como ligar o sistema no computador do quiosque, abrir o caixa do dia e cuidar do seu PIN.',
    blocks: [
      { h: 'Como funciona o acesso no quiosque', p: 'O computador do quiosque entra uma vez com a senha da unidade e fica aberto o dia todo. A vendedora não tem login próprio: ela toca no nome dela e digita o PIN de 4 números sempre que o sistema pede (vender, fechar o caixa, sangria, garantia, estoque). Assim cada venda e cada movimento ficam no nome de quem fez.' },
      { h: 'Entrar na unidade', steps: ['Abra o endereço do sistema da rede no navegador do quiosque.', 'Na tela "Entrar na unidade", escolha a sua unidade na lista.', 'Digite a senha da unidade (a senha do computador do quiosque, não o seu PIN).', 'Toque em "Abrir o caixa da unidade". O sistema abre na tela Caixa.'], img: 'v-entrar.png', cap: 'Tela "Entrar na unidade"' },
      { warn: 'A senha da unidade é do computador do quiosque. Não anote em papel colado no balcão e não passe para clientes. Se ela vazar, a gestão troca no painel da rede e a antiga para de valer na hora.' },
      { h: 'Abrir o caixa do dia', p: 'Quando o caixa está fechado, a tela Caixa mostra "O caixa está fechado".', steps: ['Conte o dinheiro que está na gaveta.', 'Digite o valor em "Dinheiro na gaveta (R$)". Se a gaveta estiver vazia, digite 0.', 'Toque em "Abrir o caixa".', 'Toque no seu nome em "Quem está abrindo?" e digite o seu PIN.'], img: 'v-abrir-caixa.png', cap: 'Caixa fechado: informe o dinheiro da gaveta' },
      { tip: 'O valor de abertura é a base do fechamento: no fim do dia o sistema calcula quanto dinheiro deveria estar na gaveta a partir dele. Conte com cuidado.' },
      { h: 'Trocar o seu PIN', steps: ['No canto inferior esquerdo, toque em "Trocar meu PIN".', 'Escolha o seu nome.', 'Digite o PIN atual, o PIN novo (4 números) e repita o PIN novo.', 'Toque em "Salvar".'] },
      { h: 'Esqueceu o PIN?', p: 'Peça ao supervisor ou à gestão. Eles geram um PIN novo no painel da rede (Pessoas e acessos → Novo PIN). O PIN antigo para de valer na hora. Depois, troque por um PIN só seu em "Trocar meu PIN".' },
      { warn: 'O PIN é pessoal. Tudo o que for feito com o seu PIN fica no seu nome, inclusive vendas e comissão. Não use o PIN de colega e não passe o seu.' },
      { h: 'Sair do quiosque', p: 'O botão "Sair do quiosque" (canto inferior esquerdo) desliga o acesso do computador. Para entrar de novo será preciso a senha da unidade. No dia a dia não é preciso sair: o computador fica aberto.' }
    ]
  },
  {
    key: 'v-venda', group: 'caixa', version: 1, audiences: ALL, title: 'Fazer uma venda',
    summary: 'Passo a passo da venda no caixa: peças, cliente, pagamento, desconto e confirmação com o PIN.',
    blocks: [
      { h: 'Visão geral da tela Caixa', list: ['À esquerda: a busca (bipe ou digite) e a lista de peças da venda.', 'À direita, em cima: a cliente.', 'À direita, embaixo: a forma de pagamento, quem está vendendo, o total e o botão "Finalizar venda".'], img: 'v-caixa.png', cap: 'Tela Caixa com uma venda em andamento' },
      { h: '1. Colocar as peças', steps: ['Com o cursor no campo "Bipe a etiqueta ou digite o código da peça", passe o leitor na etiqueta. A peça entra na venda.', 'Sem etiqueta? Digite o código ou parte do nome (ex.: "estrela") e escolha a peça na lista que aparece.', 'Para mais de uma unidade da mesma peça, bipe de novo ou use o "+" na linha da peça.', 'Para tirar, use o "−" até a peça sair da lista.'] },
      { tip: 'Código com zeros na frente funciona: 000573 e 573 acham a mesma peça. Se duas peças servirem, o sistema mostra a lista para você escolher.' },
      { warn: 'Apareceu "Peça não encontrada"? Confira o código na etiqueta. Não venda uma peça "parecida" no lugar: o estoque das duas fica errado. Avise o supervisor para cadastrar a peça.' },
      { h: '2. Escolher a cliente', p: 'Digite o telefone ou o nome no campo "Telefone ou nome da cliente" e toque na cliente certa. Ela não tem cadastro? Toque em "Cadastrar cliente" (veja a página "Cliente na venda e cadastro"). Se ela não quiser se identificar, deixe em branco: a venda sai sem cliente.' },
      { tip: 'Venda com cliente gera cashback, comprovante e garantia no WhatsApp dela. Sempre que possível, identifique a cliente.' },
      { h: '3. Forma de pagamento', p: 'Toque em Crédito, Débito, Pix ou Dinheiro.', list: ['Dinheiro: aparece "Desconto de 10% no dinheiro". Marque só se a rede autorizou o desconto para essa venda.', 'Pix: aparece "Desconto de 5% no Pix", com a mesma regra.', 'Crédito com o pinpad ligado: escolha as parcelas.', 'O total à direita já mostra o desconto e o cashback usado.'] },
      { h: '4. Quem está vendendo', steps: ['Em "Quem está vendendo?", toque no seu nome.', 'Digite o seu PIN.', 'Aparece "✓ PIN confirmado". A venda e a comissão ficam no seu nome.'] },
      { h: '5. Finalizar', steps: ['Confira peças, cliente, forma de pagamento e total.', 'Toque em "Finalizar venda".', 'Com o pinpad Stone ligado, o valor vai sozinho para o pinpad: a cliente passa o cartão ou paga o Pix. Sem o pinpad ligado, digite o valor na maquininha.', 'Aparece "Venda nº ... registrada". Envie o comprovante (página "Depois da venda").', 'Toque em "Nova venda" para começar a próxima.'] },
      { warn: 'Se aparecer "O pagamento foi APROVADO no pinpad, mas a venda não gravou", NÃO cobre de novo. Corrija o que a mensagem pedir e toque em "Finalizar venda" outra vez: o sistema usa a cobrança já aprovada.' },
      { h: 'O que acontece sozinho ao finalizar', list: ['O estoque das peças sai da sua unidade.', 'O cashback da cliente é calculado e somado ao saldo dela.', 'A venda entra no "Meu dia" de quem vendeu e no painel da supervisão.'] }
    ]
  },
  {
    key: 'v-cliente', group: 'caixa', version: 1, audiences: ALL, title: 'Cliente na venda e cadastro',
    summary: 'Buscar, cadastrar e trocar a cliente da venda; o que é obrigatório e o que a cliente pode recusar.',
    blocks: [
      { h: 'Buscar a cliente', p: 'O cadastro de clientes é único da rede: uma cliente cadastrada em qualquer unidade aparece em todas. Busque pelo telefone (mais seguro) ou pelo nome.' },
      { h: 'Cadastrar na hora da venda', steps: ['Toque em "Cadastrar cliente", embaixo da busca.', 'Preencha pelo menos o nome. WhatsApp é o mais importante: é por ele que vão o comprovante, a garantia e o cashback.', 'CPF, e-mail e aniversário ajudam (o aniversário entra nas mensagens de aniversário).', 'Se a cliente não quiser receber ofertas, marque "Não quer receber ofertas e campanhas pelo WhatsApp". Ela continua recebendo o comprovante da compra.', 'Finalize a venda normalmente: o cadastro é salvo junto.'] },
      { warn: 'Aparecendo "CPF inválido", confira os números com a cliente. Não invente CPF.' },
      { h: 'Trocar a cliente', p: 'Escolheu a cliente errada? Toque em "Trocar" ao lado do nome e busque de novo, antes de finalizar. Depois de finalizada, só o supervisor ou a gestão corrigem a cliente da venda pelo painel da rede.' },
      { h: 'Venda sem cliente', p: 'Se a cliente não quiser se identificar, não preencha nada. A venda sai sem cliente: não gera cashback e não há comprovante pelo WhatsApp. Uma troca futura com crédito exige que o supervisor inclua a cliente na venda antes.' }
    ]
  },
  {
    key: 'v-cashback', group: 'caixa', version: 1, audiences: ALL, title: 'Cashback',
    summary: 'Como a cliente ganha, consulta e usa o cashback em qualquer unidade.',
    blocks: [
      { h: 'Ganhar', p: 'Toda venda com cliente identificada gera cashback, conforme as regras da rede (percentual, compra mínima e validade, definidos pela gestão). O valor ganho aparece na confirmação da venda e na mensagem de WhatsApp.' },
      { h: 'Ver o saldo', p: 'Ao escolher a cliente na venda, aparece "Cashback disponível" com o saldo dela. O saldo vale em qualquer unidade da rede.' },
      { h: 'Usar na compra', steps: ['Escolha a cliente.', 'Marque "Usar o cashback nesta compra".', 'O valor descontado aparece ao lado e no total.'] },
      { tip: 'Existe um limite de uso por compra (um percentual do valor da compra, definido pela gestão). Por isso nem sempre o saldo todo é usado de uma vez: o que sobra continua no saldo.' },
      { h: 'Validade', p: 'O cashback vence depois do prazo definido pela rede. Perto do vencimento, a cliente aparece na aba Mensagens com o aviso "Cashback vencendo", para você lembrar.' }
    ]
  },
  {
    key: 'v-pinpad', group: 'caixa', version: 1, audiences: ALL, title: 'Pinpad Stone: pagamentos e problemas',
    summary: 'Cobrança no pinpad integrado, pinpad fora do ar, pendências e estorno.',
    blocks: [
      { p: 'Enquanto o pinpad integrado (TEF) não estiver ligado na sua unidade, a tela mostra "Stone: integração em implantação" e você digita o valor na maquininha, como hoje. Quando for ligado, o valor vai sozinho do caixa para o pinpad.' },
      { h: 'Cobrar no pinpad', steps: ['Monte a venda e escolha Crédito, Débito ou Pix.', 'No crédito, escolha as parcelas.', 'Toque em "Finalizar venda": o valor aparece no pinpad.', 'A cliente passa o cartão ou paga o QR Code do Pix (o QR também aparece na tela).', 'Aprovado, a venda grava sozinha.'] },
      { h: 'Pinpad fora do ar', p: 'Se o pinpad não funcionar, use a maquininha avulsa:', steps: ['Cobre na maquininha avulsa.', 'No caixa, marque "Pinpad fora do ar: cobrei na maquininha avulsa".', 'Digite a autorização do comprovante (AUT/NSU) no campo que aparece.', 'Finalize. A venda fica marcada para conciliação e o supervisor confere.'] },
      { h: 'Pendências do pinpad', p: 'Quando uma cobrança foi aprovada mas a venda não gravou, ou o pinpad não respondeu, aparece o quadro "Pendências do pinpad" no caixa.', list: ['"Estornar no pinpad": devolve a cobrança no cartão. Precisa do MESMO cartão da compra.', 'Pix: a devolução é feita pelo app da Stone. Depois, marque como "Resolvido".', '"Resolvido": use depois de conferir no app da Stone, escrevendo o que foi conferido.'] },
      { warn: 'Se o pinpad não respondeu, NÃO cobre de novo antes de conferir no app da Stone se a cobrança passou. Cobrar duas vezes a mesma cliente é o erro mais grave do caixa.' }
    ]
  },
  {
    key: 'v-depois', group: 'caixa', version: 1, audiences: ALL, title: 'Depois da venda: comprovante e garantia',
    summary: 'Enviar o comprovante e o cashback pelo WhatsApp e explicar a garantia para a cliente.',
    blocks: [
      { h: 'Enviar pelo WhatsApp', steps: ['Depois de finalizar, toque em "Enviar comprovante e cashback pelo WhatsApp".', 'Abre o WhatsApp do quiosque com a mensagem pronta para a cliente: agradecimento, cashback ganho, saldo e o link do comprovante com a garantia.', 'Confira e envie.'], img: 'v-venda-ok.png', cap: 'Venda registrada, com o envio pelo WhatsApp' },
      { tip: 'Se não der para enviar na hora, a mensagem fica na aba Mensagens ("Obrigado pela compra") para enviar depois.' },
      { h: 'O comprovante', p: 'Cada venda tem um código de 8 letras e números (aparece em "Ver comprovante"). Pelo link, a cliente vê as peças, os valores e a garantia de cada joia. É esse código que ela traz para qualquer atendimento de garantia, em qualquer unidade.' }
    ]
  },
  {
    key: 'v-meudia', group: 'caixa', version: 1, audiences: ALL, title: 'Meu dia',
    summary: 'Suas vendas de hoje, o faturamento da loja, a sua meta e a comissão prevista.',
    blocks: [
      { steps: ['Toque em "Meu dia" no menu.', 'Toque no seu nome e digite o seu PIN.', 'Veja: minhas vendas hoje, faturamento da loja hoje, comissão prevista no mês, a sua meta e a lista das suas vendas do dia.', 'Ao terminar, toque em "Sair do Meu dia" para a próxima colega não ver os seus números.'], img: 'v-meudia.png', cap: 'Meu dia' },
      { p: 'A vendedora não vê custo, lucro nem a comissão das colegas. A comissão é uma previsão: o pagamento é feito pela rede.' },
      { tip: 'Venda que não aparece no seu "Meu dia" foi registrada com outro nome. Avise o supervisor: ele corrige a vendedora da venda pelo painel da rede.' }
    ]
  },
  {
    key: 'v-clientes', group: 'caixa', version: 1, audiences: ALL, title: 'Aba Clientes',
    summary: 'Buscar clientes da rede, ver o histórico de compras e cadastrar ou corrigir dados.',
    blocks: [
      { list: ['A lista mostra clientes de todas as unidades: nome, WhatsApp, unidade do cadastro, número de compras, total e última compra.', 'Busque por nome, WhatsApp, CPF ou e-mail.', 'Ordene por "Compraram por último" ou "Nome (A–Z)".', 'Toque no nome para ver o histórico: compras, ticket médio, última compra e saldo de cashback.'], img: 'v-clientes.png', cap: 'Aba Clientes' },
      { h: 'Cadastrar ou corrigir', p: 'Use "+ Cadastrar cliente" no topo, ou abra a cliente e toque em editar. Mantenha o WhatsApp sempre certo: é por ele que a cliente recebe comprovante, garantia e cashback.' }
    ]
  },
  {
    key: 'v-mensagens', group: 'caixa', version: 1, audiences: ALL, title: 'Mensagens para as clientes',
    summary: 'A fila do dia de mensagens pelo WhatsApp: agradecimento, avaliação, cashback, aniversário e campanhas.',
    blocks: [
      { p: 'O número ao lado de "Mensagens" no menu mostra quantas mensagens estão esperando. Elas são das clientes da sua unidade.', list: ['Obrigado pela compra: comprovante e cashback que não foram enviados na hora.', 'Avaliação no Google: pedido de avaliação alguns dias depois da compra.', 'Cashback vencendo: lembrete para a cliente usar o saldo.', 'Aniversário: parabéns para as aniversariantes.', 'Campanha: campanhas criadas pela rede (ex.: Dia das Mães).'] },
      { h: 'Enviar', steps: ['Escolha a aba (ou "Todas").', 'Leia o texto. Você pode ajustar antes de enviar.', 'Toque em "Enviar pelo WhatsApp": abre a conversa com a cliente e o texto pronto.', 'Envie no WhatsApp. A mensagem sai da fila.'], img: 'v-mensagens.png', cap: 'Aba Mensagens' },
      { h: 'Não enviar', p: 'Se não fizer sentido (ex.: a cliente pediu para não receber), toque em "Não enviar". A mensagem sai da fila e fica registrado que não foi enviada.' },
      { tip: 'Apareceu "Falta o link de avaliação do Google desta unidade"? Avise a gestão: sem o link, os pedidos de avaliação não aparecem.' }
    ]
  },
  {
    key: 'v-garantia', group: 'caixa', version: 1, audiences: ALL, title: 'Garantia, troca e devolução',
    summary: 'Encontrar a venda pelo comprovante, conferir a garantia e registrar o atendimento.',
    blocks: [
      { h: 'Encontrar a venda', steps: ['Toque em "Garantia" no menu.', 'Digite o código do comprovante (8 letras e números) que a cliente recebeu no WhatsApp.', 'Toque em "Buscar". Vale para venda de qualquer unidade.'], img: 'v-garantia.png', cap: 'Garantia: busca pelo código do comprovante' },
      { p: 'Aparecem a venda, as peças, a garantia de cada joia (em verde, até quando vale; em cinza, encerrada) e os atendimentos já registrados.' },
      { h: 'Registrar um atendimento', steps: ['Em "Registrar atendimento de garantia", escolha o tipo: Troca, Conserto, Devolução ou Outro.', 'Descreva o que aconteceu (ex.: "banho escureceu").', 'Em "Quem está atendendo?", toque no seu nome e digite o PIN.', 'Aparece "Atendimento registrado. O prazo para resolver é de 30 dias."'] },
      { h: 'Crédito para a cliente (troca ou devolução)', p: 'Em um atendimento de troca ou devolução em aberto, aparece "Gerar crédito para a cliente". O valor vira saldo da cliente (como cashback) e vale em qualquer unidade.', steps: ['Toque em "Gerar crédito para a cliente".', 'Confirme o valor.', 'Um supervisor, gerente ou dono digita o PIN dele para liberar.'] },
      { warn: 'Crédito só com o PIN do supervisor ou da gestão. Se a venda não tem cliente, o supervisor precisa incluir a cliente na venda pelo painel da rede antes.' }
    ]
  },
  {
    key: 'v-estoque', group: 'caixa', version: 1, audiences: ALL, title: 'Estoque no quiosque',
    summary: 'Consultar peças na rede, receber e enviar transferências e fazer a contagem da unidade.',
    blocks: [
      { h: 'Consultar', p: 'Na aba "Consultar", filtre por código, nome ou família. A tabela mostra quantas peças há em cada unidade (em verde). Use "Acabou aqui, tem em outra" para achar a peça em outra unidade quando a cliente pedir.', img: 'v-estoque.png', cap: 'Estoque → Consultar' },
      { h: 'Receber uma transferência', steps: ['Abra a aba "Receber" (o número mostra quantas transferências estão chegando).', 'Abra a transferência e bipe as peças que chegaram.', 'Confirme com o seu PIN.'] },
      { warn: 'Chegou quantidade diferente do que foi enviado? O sistema avisa e pede confirmação. Confirme com a quantidade REAL que chegou: a diferença vai para o supervisor conferir.' },
      { h: 'Enviar para outra unidade', steps: ['Abra a aba "Enviar".', 'Escolha a unidade de destino.', 'Bipe as peças que vão.', 'Se quiser, escreva uma observação.', 'Em "Quem está enviando?", toque no seu nome e digite o PIN. O estoque sai da sua unidade na hora.'] },
      { h: 'Contagem', steps: ['Abra a aba "Contagem".', 'Bipe cada peça da unidade, uma vez por peça. A contagem fica guardada neste computador até ser aplicada.', 'Confira a tabela: contadas x no sistema.', 'Em "Quem contou?", toque no seu nome e digite o PIN para aplicar.'] },
      { warn: 'A opção "Peças não contadas ficam com estoque zero" é para a contagem COMPLETA da unidade. Se você contou só uma parte, não marque: as outras peças ficariam zeradas.' }
    ]
  },
  {
    key: 'v-fechar', group: 'caixa', version: 1, audiences: ALL, title: 'Vendas do dia, sangria e fechamento',
    summary: 'Ver as vendas do caixa, tirar dinheiro da gaveta, cancelar venda e fechar o caixa.',
    blocks: [
      { h: 'Vendas do dia', p: 'Em "Vendas e caixa" aparecem as vendas do caixa aberto: número, hora, vendedora, cliente, valor e forma.', img: 'v-vendas-caixa.png', cap: 'Vendas e caixa' },
      { h: 'Sangria (retirar dinheiro)', steps: ['Em "Sangria", digite o valor retirado.', 'Escreva o motivo (ex.: "depósito no banco").', 'Toque no seu nome e digite o PIN.'] },
      { h: 'Cancelar uma venda', steps: ['Na lista de vendas, toque em "Cancelar" na venda.', 'Escreva o motivo do cancelamento.', 'Quem vendeu digita o PIN.', 'Um supervisor, gerente ou dono digita o PIN dele para autorizar.', 'Se a venda foi no pinpad, o sistema oferece o estorno (precisa do mesmo cartão).'] },
      { h: 'Fechar o caixa', steps: ['Toque em "Fechar caixa" (no topo da tela Caixa ou em "Vendas e caixa").', 'Veja o "Dinheiro esperado na gaveta".', 'Conte o dinheiro e digite em "Dinheiro contado na gaveta" (0 se não tiver).', 'Toque no seu nome e digite o PIN.', 'O sistema mostra se houve diferença.'], img: 'v-fechar.png', cap: 'Fechar o caixa' },
      { warn: 'Digite o valor que você CONTOU, não o esperado. A diferença aparece para o supervisor conferir; esconder diferença atrapalha achar o erro.' },
      { p: 'Depois de fechado, novas vendas só com o caixa aberto de novo.' }
    ]
  },

  // ======================= SUPERVISÃO (painel da rede) =======================
  {
    key: 's-painel', group: 'rede', version: 1, audiences: LEAD, title: 'Painel da rede: entrar e visão geral',
    summary: 'Como entrar, escolher a unidade e o período, e o que olhar primeiro todos os dias.',
    blocks: [
      { h: 'Entrar', list: ['Pelo navegador, com o seu e-mail e senha.', 'Ou pelo próprio quiosque: na tela "Entrar na unidade", digite a SUA senha no lugar da senha da unidade. Abre o painel da rede. O supervisor só entra assim nas unidades que acompanha.'] },
      { warn: 'Ao terminar no quiosque, toque em "Sair". Senão a vendedora fica com o seu painel aberto.' },
      { h: 'Unidade e período', p: 'No alto do menu, "Unidade" escolhe uma unidade ou "Todas as unidades". O supervisor vê só as unidades dele. Na Visão geral, escolha Hoje, Ontem, 7 dias, Este mês ou "Período…".', img: 's-visao-geral.png', cap: 'Visão geral' },
      { h: 'O que a Visão geral mostra', list: ['Números do período: vendas, faturamento, ticket médio e meta.', 'Unidades: vendas, faturamento, ticket, meta do mês e situação do caixa de cada unidade. Atualiza sozinho.', 'Formas de pagamento por unidade.', '"Precisa de atenção": o que pede ação (caixa sem conferência, garantia perto do prazo, transferência com diferença, pagamento a conciliar).'] },
      { tip: 'Comece o dia pelo "Precisa de atenção" e pelo Painel da loja de cada unidade.' }
    ]
  },
  {
    key: 's-loja', group: 'rede', version: 1, audiences: LEAD, title: 'Painel da loja: conferir o caixa e corrigir vendas',
    summary: 'O dia de uma unidade: fechamentos, pendências e correção de venda com motivo.',
    blocks: [
      { steps: ['Escolha a unidade no menu (Unidade).', 'Abra "Painel da loja" e escolha o dia.'], img: 's-painel-loja.png', cap: 'Painel da loja' },
      { h: 'Conferir os fechamentos', p: 'Em "Fechamentos" aparece cada caixa fechado: dinheiro esperado, contado e diferença. Confira com a vendedora e marque como conferido; fica "Conferido por" com o seu nome. Fechamento sem conferência fica em "Precisa de atenção".' },
      { h: 'Caixa por forma de pagamento', p: 'Mostra quanto entrou em dinheiro, Pix, débito e crédito no dia. Compare com a maquininha e o extrato.' },
      { h: 'Corrigir uma venda', p: 'Em "Vendas do dia", use "Corrigir" para trocar a vendedora, a cliente ou a forma de pagamento de uma venda.', steps: ['Toque em "Corrigir" na venda.', 'Escolha o que mudar.', 'Escreva o motivo (obrigatório).', 'Salve. A correção fica no histórico, com o seu nome.'] },
      { warn: 'Corrigir a vendedora muda a comissão das duas vendedoras. Corrija só com certeza de quem vendeu.' },
      { h: 'Pendências', p: 'O quadro de pendências da unidade lista garantias perto do prazo de 30 dias, transferências recebidas com diferença e vendas na maquininha avulsa a conciliar.' }
    ]
  },
  {
    key: 's-autorizar', group: 'rede', version: 1, audiences: LEAD, title: 'Autorizações no quiosque e PIN das vendedoras',
    summary: 'O que só o supervisor libera com o PIN dele e como gerar PIN novo para a vendedora.',
    blocks: [
      { h: 'O seu PIN', p: 'Além da senha do painel, o supervisor tem um PIN de 4 números para autorizar no quiosque. Quem gera o PIN do supervisor é a gestão (Pessoas e acessos → "Novo PIN"). Ainda não tem ou esqueceu? Peça à gestão.' },
      { h: 'O que pede o PIN do supervisor', list: ['Cancelar venda: o PIN de quem vendeu e o PIN do supervisor, gerente ou dono.', 'Crédito de troca ou devolução na Garantia.'] },
      { warn: 'Nunca passe o seu PIN para a vendedora "adiantar". Cada autorização fica registrada no seu nome.' },
      { h: 'PIN novo para a vendedora', steps: ['Abra "Pessoas e acessos".', 'Na linha da vendedora, toque em "Novo PIN" e confirme.', 'Passe o PIN temporário para ela pessoalmente.', 'Peça para ela trocar em "Trocar meu PIN" no quiosque.'], img: 's-pessoas.png', cap: 'Pessoas e acessos' },
      { p: 'O supervisor vê e gera PIN só para as vendedoras das unidades dele. Cadastrar ou desativar pessoas é com a gestão.' }
    ]
  },
  {
    key: 's-estoque', group: 'rede', version: 1, audiences: LEAD, title: 'Estoque da rede',
    summary: 'Estoque por unidade, cadastro de peças, entrada, etiquetas, reposição e histórico.',
    blocks: [
      { p: 'Em "Estoque", o cadastro e o preço das peças valem para todas as unidades. As abas:', list: ['Estoque por unidade: a quantidade de cada peça em cada unidade. Filtre por código, família, "Zerada na unidade escolhida, com estoque em outra" ou "Sem estoque em nenhuma".', 'Produtos: cadastrar e editar peças (código, nome, família, preço, NCM).', 'Entrada rápida: dar entrada de peças que chegaram, bipando.', 'Etiquetas: imprimir etiquetas com código de barras.', 'Gerar códigos: criar códigos para peças sem código.', 'Reposição: peças abaixo do mínimo, por unidade, para pedir ou transferir.', 'Histórico: tudo o que entrou, saiu, foi transferido ou contado, com quem fez.', 'Preços: ajustar preços.'], img: 's-estoque.png', cap: 'Estoque por unidade' },
      { p: 'O custo e o "Valor do estoque" aparecem só para a gestão. O supervisor pode informar o custo na entrada.' },
      { tip: 'Transferência recebida com diferença aparece em "Precisa de atenção". Confira com as duas unidades antes de ajustar.' }
    ]
  },
  {
    key: 's-metas', group: 'rede', version: 1, audiences: LEAD, title: 'Metas e comissões',
    summary: 'Metas das unidades e das vendedoras e a comissão prevista do mês.',
    blocks: [
      { h: 'Metas', steps: ['Abra "Metas" e escolha o mês.', 'Clique na unidade para ver as vendedoras.', 'Preencha a meta da unidade e de cada vendedora.', 'Toque em "Salvar metas".'], img: 's-metas.png', cap: 'Metas' },
      { p: 'Sem meta nova, vale a do mês anterior. A meta da rede é definida pela gestão. A vendedora acompanha a meta dela no "Meu dia".' },
      { h: 'Comissões', p: '"Comissões" mostra, por vendedora, as vendas, o vendido no mês, a faixa atual, a comissão prevista e quanto falta para a próxima faixa. É uma previsão: o pagamento é feito pela rede.' }
    ]
  },
  {
    key: 's-clientes', group: 'rede', version: 1, audiences: LEAD, title: 'Clientes, campanhas e mensagens',
    summary: 'Criar campanhas pelo WhatsApp e acompanhar as mensagens enviadas pelos quiosques.',
    blocks: [
      { h: 'Nova campanha', steps: ['Abra "Clientes e campanhas".', 'Dê um nome (ex.: Dia das Mães).', 'Escolha para quem: todas, sem comprar há 60 dias, aniversariantes do mês ou com saldo de cashback.', 'Escolha início e fim.', 'Escreva o texto. Use {nome}, {saldo} e {lojas} para personalizar.', 'Toque em "Criar campanha".'], img: 's-campanhas.png', cap: 'Clientes e campanhas' },
      { p: 'A campanha aparece na aba Mensagens do quiosque, e cada unidade envia para as clientes dela. Quem pediu para não receber ofertas fica de fora.' },
      { h: 'Mensagens enviadas', p: 'O quadro mostra, por unidade, quantas mensagens foram enviadas no mês (obrigado, avaliação, cashback vencendo, aniversário e campanhas) e quantas clientes abriram o link.' }
    ]
  },
  {
    key: 's-treinamento', group: 'rede', version: 1, audiences: LEAD, title: 'Acompanhar o treinamento',
    summary: 'Ver quem assistiu aos vídeos e leu o manual, e quais partes.',
    blocks: [
      { steps: ['Abra "Treinamento".', 'Em "Quem já assistiu e leu", filtre por unidade ou situação ("Não assistiu", "Começou e parou", "Viu até o final").', 'Toque na pessoa para ver as partes do vídeo e as páginas do manual que ela viu.'], img: 's-treinamento.png', cap: 'Treinamento: quem já assistiu e leu' },
      { list: ['Vídeo: conta só o que passou tocando; pular a barra não conta. "Viu até o final" a partir de 95%.', 'Manual: a página conta como lida quando a pessoa chega ao fim dela e fica o tempo mínimo de leitura.', 'A vendedora assiste e lê no quiosque com o PIN dela.'] },
      { tip: 'Use o filtro "Não assistiu" para cobrar a equipe de cada unidade.' }
    ]
  },

  // ======================= GESTÃO =======================
  {
    key: 'g-pessoas', group: 'gestao', version: 1, audiences: OWNER, title: 'Pessoas, acessos e senha do quiosque',
    summary: 'Cadastrar e desativar vendedoras e supervisores e trocar a senha do computador do quiosque.',
    blocks: [
      { h: 'Cadastrar pessoa', steps: ['Abra "Pessoas e acessos".', 'Em "Cadastrar pessoa", digite o nome.', 'Função "Vendedora (PIN)": escolha a unidade. O sistema gera um PIN temporário: passe para ela pessoalmente.', 'Função "Supervisor (e-mail e senha)": digite o e-mail e marque as unidades que ele acompanha. Ele recebe um link por e-mail para criar a senha.', 'Toque em "Cadastrar".'] },
      { h: 'Desativar e reativar', p: 'Na linha da pessoa, "Desativar" corta o acesso na hora (o histórico de vendas continua). "Reativar" devolve o acesso. Use quando alguém sair da equipe.' },
      { h: 'Supervisor sem a senha', p: '"Reenviar link de senha" manda um novo link para o e-mail do supervisor.' },
      { h: 'Senha do computador do quiosque', p: 'Em "Senha do computador do quiosque", use "Gerar senha nova" ou "Definir senha" na unidade. A senha antiga para de valer na hora: o quiosque precisa entrar de novo com a nova. O supervisor também consegue trocar a senha das unidades dele.' },
      { warn: 'Troque a senha do quiosque sempre que uma pessoa que a conhecia sair da equipe.' }
    ]
  },
  {
    key: 'g-config', group: 'gestao', version: 1, audiences: OWNER, title: 'Configurações da rede',
    summary: 'Regras de cashback, textos das mensagens automáticas, contato das unidades e estoque.',
    blocks: [
      { h: 'Cashback', list: ['Cashback ligado ou desligado.', '% de cashback sobre a compra.', 'Validade em dias.', 'Uso máximo por compra (% do valor).', 'Compra mínima para ganhar (R$).'], p: 'As regras valem para todas as unidades. Toque em "Salvar cashback".', img: 'g-config.png', cap: 'Configurações' },
      { h: 'Mensagens automáticas', p: 'Ligue ou desligue o pedido de avaliação no Google (e quantos dias depois da compra), o aviso de cashback vencendo (quantos dias antes) e as mensagens de aniversário. Edite os textos de cada uma.', list: ['Nos textos, use {nome}, {loja}, {marca}, {lojas}, {saldo}, {validade}, {cashback}, {comprovante}, {link_avaliacao} e {saldo_frase}.'] },
      { h: 'Contato das unidades', p: 'WhatsApp, horário e link de avaliação do Google de cada unidade. O link do Google é o de "Pedir avaliações" do perfil da unidade (g.page/r/…/review). Sem ele, os pedidos de avaliação não aparecem no quiosque.' },
      { h: 'Estoque e trocas', list: ['"Avisar reposição com (peças) ou menos": o mínimo que dispara o alerta de reposição.', '"Validade do crédito de troca (dias)": quanto tempo vale o crédito gerado na garantia.'] },
      { p: 'Supervisores também conseguem abrir e ajustar estas configurações. Combine na equipe quem mexe.' }
    ]
  },
  {
    key: 'g-metas-rel', group: 'gestao', version: 1, audiences: OWNER, title: 'Meta da rede, relatórios e exportação',
    summary: 'Meta do mês da rede, relatório para o shopping e exportação dos dados.',
    blocks: [
      { h: 'Meta da rede', p: 'Em "Metas", o quadro "Meta da rede" aparece só para a gestão. Digite a meta do mês e salve junto com as metas das unidades.' },
      { h: 'Relatório para o shopping', steps: ['Abra "Relatórios".', 'Escolha o mês.', 'Toque em "Baixar planilha": faturamento por unidade, dia a dia.'], img: 'g-relatorios.png', cap: 'Relatórios' },
      { h: 'Exportar dados', p: 'Escolha o período e baixe Vendas, Itens vendidos, Clientes ou Estoque em planilha (CSV). Só a gestão exporta.' },
      { h: 'Valor do estoque', p: 'Em Estoque → "Valor do estoque", só para a gestão: o valor total a custo e a preço de venda, por unidade.' }
    ]
  },
  {
    key: 'g-implantacao', group: 'gestao', version: 1, audiences: OWNER, title: 'Implantação das unidades',
    summary: 'O checklist "unidade pronta" e o aceite de cada unidade.',
    blocks: [
      { p: 'Em "Implantação", cada unidade tem o checklist da implantação: dados e cadastro, equipamentos e internet, nota fiscal, pagamento (Stone), treinamento e venda real assistida.', img: 'g-implantacao.png', cap: 'Implantação' },
      { list: ['Itens automáticos: o sistema confere sozinho nos dados reais.', 'Itens da rede (ex.: impressora, pinpad): marque "Feito" quando estiver pronto.', 'Quando todos os itens estiverem feitos, aparece "Dar aceite desta unidade": confirme que a unidade está operando conforme o checklist.'] }
    ]
  }
];

export const pageByKey = new Map(MANUAL_PAGES.map(p => [p.key, p]));
// Tempo mínimo de leitura (segundos): ~ 5 palavras por segundo, entre 15 e 90.
export function minSeconds(page) {
  const words = JSON.stringify(page.blocks).replace(/"(h|p|steps|list|tip|warn|img|cap)":/g, ' ').split(/\s+/).length;
  return Math.max(15, Math.min(90, Math.round(words / 5)));
}
