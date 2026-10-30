export const storeProfiles = {
  general: { label: 'Serviços em geral', itemType: 'other', steps: ['Recebimento', 'Em atendimento', 'Pronto para entrega'] },
  automotive: { label: 'Oficina automotiva', itemType: 'vehicle', steps: ['Recepção', 'Diagnóstico', 'Serviço', 'Inspeção', 'Pronto para retirada'] },
  bodyshop: { label: 'Funilaria e pintura', itemType: 'vehicle', steps: ['Recepção', 'Avaliação', 'Funilaria', 'Pintura', 'Polimento', 'Pronto para retirada'] },
  carwash: { label: 'Lava-jato', itemType: 'vehicle', steps: ['Recepção', 'Lavagem', 'Secagem', 'Finalização'] },
  electronics: { label: 'Assistência técnica', itemType: 'device', steps: ['Recebimento', 'Diagnóstico', 'Reparo', 'Testes', 'Pronto para retirada'] },
  pet: { label: 'Pet shop', itemType: 'pet', steps: ['Recepção', 'Banho', 'Secagem', 'Finalização', 'Pronto para retirada'] },
  food: { label: 'Delivery e alimentação', itemType: 'other', steps: ['Pedido recebido', 'Em preparação', 'Finalização', 'Pronto para entrega'] }
};
