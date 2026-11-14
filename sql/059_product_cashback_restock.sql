-- Opções por produto (definidas no cadastro):
-- - cashback: a venda desse produto gera cashback (troca de espécie por Pix, crédito de celular: desmarcar).
-- - restock: o produto entra na lista de reposição (crédito de celular, troca de espécie: desmarcar).
ALTER TABLE products ADD COLUMN IF NOT EXISTS cashback boolean NOT NULL DEFAULT true;
ALTER TABLE products ADD COLUMN IF NOT EXISTS restock boolean NOT NULL DEFAULT true;

-- Exclusão do saldo de cashback de um cliente (senha do admin). Os lotes zerados guardam a exclusão;
-- o lote não volta a valer nem se uma venda que usou esse saldo for cancelada depois.
ALTER TABLE cashback_lots ADD COLUMN IF NOT EXISTS cleared_at timestamptz;
ALTER TABLE cashback_lots ADD COLUMN IF NOT EXISTS clear_id uuid;
CREATE TABLE IF NOT EXISTS cashback_clears (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  reason text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cashback_clears_customer ON cashback_clears(tenant_id, customer_id, created_at DESC);
