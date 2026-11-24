-- Garantia digital (Audace): comprovante público da venda com prazos de garantia e registro de atendimentos.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS receipt_code text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_receipt_code ON sales(receipt_code) WHERE receipt_code IS NOT NULL;
-- Ex.: [{"label":"Defeito de fabricação","days":30},{"label":"Cor do banho","days":365}]
ALTER TABLE store_networks ADD COLUMN IF NOT EXISTS warranty_rules jsonb NOT NULL DEFAULT '[{"label":"Defeito de fabricação","days":30},{"label":"Cor do banho","days":365}]'::jsonb;
CREATE TABLE IF NOT EXISTS warranty_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sale_id uuid NOT NULL REFERENCES sales(id),
  kind text NOT NULL CHECK (kind IN ('troca', 'conserto', 'devolucao', 'outro')),
  note text CHECK (note IS NULL OR length(note) <= 300),
  opened_by uuid REFERENCES users(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  due_on date NOT NULL,
  closed_at timestamptz,
  closed_by uuid REFERENCES users(id),
  close_note text CHECK (close_note IS NULL OR length(close_note) <= 300)
);
CREATE INDEX IF NOT EXISTS idx_warranty_claims_open ON warranty_claims(tenant_id, due_on) WHERE closed_at IS NULL;
