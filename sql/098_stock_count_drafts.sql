-- Inventário: a contagem em andamento fica no servidor (uma por unidade), somando as bipagens de qualquer
-- computador da unidade. first_at = primeira bipagem da peça; ao aplicar, vendas, cancelamentos, entradas e
-- transferências da peça depois desse momento são descontados do contado.
CREATE TABLE IF NOT EXISTS stock_count_drafts (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty integer NOT NULL CHECK (qty BETWEEN 0 AND 99999),
  first_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (tenant_id, product_id)
);
