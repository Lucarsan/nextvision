-- Correção de venda pelo supervisor/dono, crédito de troca em qualquer unidade e estoque mínimo da rede.
CREATE TABLE IF NOT EXISTS sale_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES sales(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  field text NOT NULL CHECK (field IN ('seller', 'customer', 'payment_method')),
  old_value text,
  new_value text,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  corrected_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sale_corrections_sale ON sale_corrections(sale_id);
-- Crédito de troca: lote no mesmo saldo do cashback (vale em qualquer unidade da rede).
ALTER TABLE cashback_lots ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'cashback' CHECK (kind IN ('cashback', 'credit'));
ALTER TABLE cashback_lots ADD COLUMN IF NOT EXISTS warranty_claim_id uuid REFERENCES warranty_claims(id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cashback_lots_claim ON cashback_lots(warranty_claim_id) WHERE warranty_claim_id IS NOT NULL;
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS credit_cents integer CHECK (credit_cents IS NULL OR credit_cents > 0);
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS credit_authorized_by uuid REFERENCES users(id);
-- Estoque mínimo para o alerta de reposição (definido pela Audace).
ALTER TABLE store_networks ADD COLUMN IF NOT EXISTS low_stock_min integer NOT NULL DEFAULT 1 CHECK (low_stock_min BETWEEN 0 AND 1000);
ALTER TABLE store_networks ADD COLUMN IF NOT EXISTS credit_valid_days integer NOT NULL DEFAULT 180 CHECK (credit_valid_days BETWEEN 7 AND 730);
