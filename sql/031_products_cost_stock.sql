-- Produtos: preço de custo, estoque e código gerado pelo sistema; desconto na venda.
-- - cost_cents: o vendedor vê o custo para saber até onde pode dar desconto.
-- - stock_qty: NULL = não controla estoque. A venda dá baixa e o cancelamento devolve.
-- - generated_barcode: código criado pelo sistema (EAN-13 interno, começa com 2) para produto sem código.
-- - sale_items.unit_cost_cents: custo do momento da venda. sales.discount_cents: desconto dado sobre os itens.
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_cents integer CHECK (cost_cents IS NULL OR cost_cents BETWEEN 0 AND 100000000);
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_qty integer CHECK (stock_qty IS NULL OR stock_qty BETWEEN -999999 AND 999999);
ALTER TABLE products ADD COLUMN IF NOT EXISTS generated_barcode boolean NOT NULL DEFAULT false;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS unit_cost_cents integer;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_cents integer NOT NULL DEFAULT 0 CHECK (discount_cents BETWEEN 0 AND 100000000);
CREATE SEQUENCE IF NOT EXISTS product_internal_code_seq;
