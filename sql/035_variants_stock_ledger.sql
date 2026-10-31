-- Produto com modelos (película, capinha): um código geral; na venda o sistema pergunta o modelo.
-- Cada modelo tem estoque próprio e conta o que foi vendido e ainda não foi reposto.
ALTER TABLE products ADD COLUMN IF NOT EXISTS ask_variant boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS restock_pending integer NOT NULL DEFAULT 0 CHECK (restock_pending >= 0);
CREATE TABLE IF NOT EXISTS product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  product_id uuid NOT NULL REFERENCES products(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  stock_qty integer CHECK (stock_qty IS NULL OR stock_qty BETWEEN -999999 AND 999999),
  restock_pending integer NOT NULL DEFAULT 0 CHECK (restock_pending >= 0),
  sold_count integer NOT NULL DEFAULT 0,
  last_sold_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_product_variants_name ON product_variants(product_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_product_variants_tenant ON product_variants(tenant_id, product_id);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS variant_id uuid REFERENCES product_variants(id);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS variant_name text;
-- Movimentos de estoque: entradas (compras, com custo), vendas, cancelamentos e ajustes. Base dos relatórios.
CREATE TABLE IF NOT EXISTS stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  product_id uuid NOT NULL REFERENCES products(id),
  variant_id uuid REFERENCES product_variants(id),
  kind text NOT NULL CHECK (kind IN ('entry', 'sale', 'cancel', 'adjust')),
  quantity integer NOT NULL,
  unit_cost_cents integer,
  sale_id uuid REFERENCES sales(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_tenant_time ON stock_movements(tenant_id, created_at);
