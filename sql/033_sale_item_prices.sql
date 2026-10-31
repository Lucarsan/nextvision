-- Preço por item na venda: o vendedor pode mudar o preço de cada item na hora.
-- unit_price_cents/total_cents = valor de fato cobrado; list_price_cents = preço de cadastro no momento.
-- Itens sem produto (itens frequentes, valor avulso) também viram linhas da venda.
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS list_price_cents integer CHECK (list_price_cents IS NULL OR list_price_cents BETWEEN 0 AND 100000000);
