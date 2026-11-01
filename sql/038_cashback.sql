-- Cashback: parte do valor pago em cada venda volta para o cliente como saldo para usar na loja.
-- - Desligado por padrão; o dono liga em Mensagens → Configurar (percentual, validade, limite de uso).
-- - Cada venda com cliente gera um "lote" (cashback_lots) com validade própria (último dia válido em expires_on).
-- - Ao usar, o saldo é consumido do lote que vence primeiro (cashback_uses + cashback_use_lots),
--   para o cancelamento devolver exatamente o que saiu de cada lote.
-- - Vencido = lote com expires_on anterior a hoje (no fuso da loja). Não há rotina apagando nada.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cashback_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cashback_percent numeric(5,2) NOT NULL DEFAULT 5
  CHECK (cashback_percent > 0 AND cashback_percent <= 50);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cashback_max_use_percent integer NOT NULL DEFAULT 30
  CHECK (cashback_max_use_percent BETWEEN 1 AND 100);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cashback_valid_days integer NOT NULL DEFAULT 90
  CHECK (cashback_valid_days BETWEEN 7 AND 730);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cashback_min_sale_cents integer NOT NULL DEFAULT 0
  CHECK (cashback_min_sale_cents BETWEEN 0 AND 100000000);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cashback_rules text NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cashback_reminder_message text NOT NULL DEFAULT '';

ALTER TABLE sales ADD COLUMN IF NOT EXISTS cashback_used_cents integer NOT NULL DEFAULT 0
  CHECK (cashback_used_cents BETWEEN 0 AND 100000000);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS cashback_earned_cents integer NOT NULL DEFAULT 0
  CHECK (cashback_earned_cents BETWEEN 0 AND 100000000);

CREATE TABLE IF NOT EXISTS cashback_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  sale_id uuid UNIQUE REFERENCES sales(id),
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
  remaining_cents integer NOT NULL CHECK (remaining_cents >= 0),
  percent_snapshot numeric(5,2) NOT NULL,
  expires_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reversed_at timestamptz,
  CHECK (remaining_cents <= amount_cents)
);
CREATE INDEX IF NOT EXISTS idx_cashback_lots_customer ON cashback_lots(tenant_id, customer_id, expires_on) WHERE reversed_at IS NULL AND remaining_cents > 0;
CREATE INDEX IF NOT EXISTS idx_cashback_lots_expiry ON cashback_lots(tenant_id, expires_on) WHERE reversed_at IS NULL AND remaining_cents > 0;

CREATE TABLE IF NOT EXISTS cashback_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  sale_id uuid NOT NULL UNIQUE REFERENCES sales(id),
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  reversed_at timestamptz
);
CREATE TABLE IF NOT EXISTS cashback_use_lots (
  use_id uuid NOT NULL REFERENCES cashback_uses(id),
  lot_id uuid NOT NULL REFERENCES cashback_lots(id),
  amount_cents integer NOT NULL CHECK (amount_cents >= 1),
  PRIMARY KEY (use_id, lot_id)
);

-- Aviso de vencimento enviado pelo WhatsApp (aba Cashback em Mensagens).
ALTER TABLE customer_messages DROP CONSTRAINT IF EXISTS customer_messages_kind_check;
ALTER TABLE customer_messages ADD CONSTRAINT customer_messages_kind_check CHECK (kind IN ('status', 'offer', 'cashback'));
