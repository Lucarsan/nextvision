-- Produtos com código de barras e itens da venda.
-- O leitor de código de barras (USB, modo teclado) "digita" o código e Enter; o Caixa
-- procura o produto pelo código e adiciona à venda. Sem controle de estoque por enquanto.

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  barcode text CHECK (barcode IS NULL OR barcode ~ '^[!-~]{3,64}$'),
  price_cents integer NOT NULL CHECK (price_cents BETWEEN 0 AND 100000000),
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Um código por produto ativo na loja; produto excluído libera o código.
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode ON products(tenant_id, barcode) WHERE barcode IS NOT NULL AND active;
CREATE INDEX IF NOT EXISTS idx_products_tenant_name ON products(tenant_id, active, name);

-- Itens guardam nome, código e preço do momento da venda (o produto pode mudar depois).
CREATE TABLE IF NOT EXISTS sale_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sale_id uuid NOT NULL REFERENCES sales(id),
  product_id uuid REFERENCES products(id),
  name text NOT NULL,
  barcode text,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 9999),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents BETWEEN 0 AND 100000000),
  total_cents integer NOT NULL CHECK (total_cents BETWEEN 0 AND 100000000),
  position integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id, position);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(tenant_id, product_id);
