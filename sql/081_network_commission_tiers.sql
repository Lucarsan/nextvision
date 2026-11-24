-- Comissão por faixa na rede (Audace: 2%, 3% e 4%): a faixa alcançada pelas vendas do mês da vendedora vale sobre o total do mês.
-- Ex.: [{"min_cents":0,"percent":2},{"min_cents":2000000,"percent":3},{"min_cents":3000000,"percent":4}]
ALTER TABLE store_networks ADD COLUMN IF NOT EXISTS commission_tiers jsonb NOT NULL DEFAULT '[]'::jsonb;
