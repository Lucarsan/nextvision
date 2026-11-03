-- 1) Capas e películas contadas no total: um código geral, a venda pergunta o modelo, mas o estoque fica no produto
--    (a loja contou "349 capas", não "5 capas de A12"). Cada modelo vendido entra na lista de reposição.
--    'model' = estoque por modelo (como era); 'total' = estoque só no produto, modelos para reposição e relatório.
ALTER TABLE products ADD COLUMN IF NOT EXISTS variant_stock text NOT NULL DEFAULT 'model';
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_variant_stock_check;
ALTER TABLE products ADD CONSTRAINT products_variant_stock_check CHECK (variant_stock IN ('model', 'total'));

-- 2) Brinde: item dado junto com um serviço (ex.: película aplicada de graça na troca de tela).
--    Sai do estoque e o custo entra nos custos; o preço é zero.
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS gift boolean NOT NULL DEFAULT false;

-- 3) Reajuste de preços em lote (com senha do admin), com registro para poder desfazer.
CREATE TABLE IF NOT EXISTS price_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  percent numeric(6,2) NOT NULL CHECK (percent BETWEEN -90 AND 500 AND percent <> 0),
  rounding text NOT NULL DEFAULT 'none' CHECK (rounding IN ('none', '0.10', '0.50', '1.00')),
  scope text NOT NULL CHECK (scope IN ('all', 'selected')),
  products_count integer NOT NULL DEFAULT 0,
  note text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  undone_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_price_batches_tenant ON price_batches(tenant_id, created_at DESC);
CREATE TABLE IF NOT EXISTS price_batch_items (
  batch_id uuid NOT NULL REFERENCES price_batches(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  old_cents integer NOT NULL,
  new_cents integer NOT NULL,
  PRIMARY KEY (batch_id, product_id)
);

-- 4) Preço por época do mês: entre o dia X e o dia Y, os produtos escolhidos sobem (ou descem) N%.
--    Fora do período o preço volta ao normal. Uma regra ativa por produto de cada vez.
CREATE TABLE IF NOT EXISTS price_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  percent numeric(6,2) NOT NULL CHECK (percent BETWEEN -90 AND 500 AND percent <> 0),
  rounding text NOT NULL DEFAULT 'none' CHECK (rounding IN ('none', '0.10', '0.50', '1.00')),
  day_from smallint NOT NULL CHECK (day_from BETWEEN 1 AND 31),
  day_to smallint NOT NULL CHECK (day_to BETWEEN 1 AND 31),
  product_ids uuid[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_price_rules_tenant ON price_rules(tenant_id) WHERE deleted_at IS NULL;
-- Preço aplicado por uma regra: guarda o preço normal para voltar quando o período acaba.
CREATE TABLE IF NOT EXISTS price_rule_applied (
  product_id uuid PRIMARY KEY REFERENCES products(id),
  rule_id uuid NOT NULL REFERENCES price_rules(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  base_cents integer NOT NULL,
  applied_cents integer NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_price_rule_applied_tenant ON price_rule_applied(tenant_id);
