-- Serviços no caixa (troca de tela, bateria, conserto…) e estoque de peças usadas nos serviços.
-- - suppliers / device_models: nomes que a loja já usou, sugeridos pelos mais usados. Crescem sozinhos
--   a cada venda de serviço ou peça cadastrada.
-- - products.kind='part': peça de serviço (tela, bateria…). Usa o mesmo estoque, custo, entrada,
--   reposição e relatório de compras dos produtos, mas não aparece na busca de produtos do caixa.
-- - sale_items.service: linha de serviço, com fornecedor, aparelho e garantia gravados no momento da venda.
--   product_id aponta para a peça usada (se houver): a venda baixa o estoque dela e o cancelamento devolve.
CREATE TABLE IF NOT EXISTS suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  phone text CHECK (phone IS NULL OR length(phone) <= 30),
  uses integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_suppliers_name ON suppliers(tenant_id, lower(name));

CREATE TABLE IF NOT EXISTS device_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  uses integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_device_models_name ON device_models(tenant_id, lower(name));

ALTER TABLE products ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'product' CHECK (kind IN ('product', 'part'));
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES suppliers(id);
ALTER TABLE products ADD COLUMN IF NOT EXISTS device_model text CHECK (device_model IS NULL OR length(device_model) <= 80);
CREATE INDEX IF NOT EXISTS idx_products_tenant_kind ON products(tenant_id, kind) WHERE active;

ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS service boolean NOT NULL DEFAULT false;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS supplier_name text;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS device_model text;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS warranty_days integer CHECK (warranty_days IS NULL OR warranty_days BETWEEN 0 AND 3650);

-- Serviços pré-cadastrados: botões rápidos no modo Serviço do caixa, com preço (e custo) sugeridos.
-- Na primeira vez que a loja abre o modo Serviço, recebe uma lista inicial sem preço (a loja define os seus).
CREATE TABLE IF NOT EXISTS service_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  price_cents integer CHECK (price_cents IS NULL OR price_cents BETWEEN 0 AND 100000000),
  cost_cents integer CHECK (cost_cents IS NULL OR cost_cents BETWEEN 0 AND 100000000),
  position integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_service_catalog_name ON service_catalog(tenant_id, lower(name)) WHERE active;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS service_catalog_seeded boolean NOT NULL DEFAULT false;
