-- Caixa diário, vendas ligadas a clientes, fidelidade por venda e mensagens de status.
-- Recursos ligados por loja pela central (tenants.sales_enabled); desligado por padrão.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sales_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS google_review_url text
  CHECK (google_review_url IS NULL OR (google_review_url ~ '^https://\S+$' AND length(google_review_url) <= 500));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS loyalty_rules text NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS loyalty_min_sale_cents integer NOT NULL DEFAULT 0
  CHECK (loyalty_min_sale_cents BETWEEN 0 AND 100000000);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status_message text NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS offer_message text NOT NULL DEFAULT '';

-- Chave de telefone para não duplicar clientes: DDD + 8 últimos dígitos
-- (ignora +55, zero de operadora e o nono dígito).
CREATE OR REPLACE FUNCTION fp_phone_key(p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
BEGIN
  IF length(d) IN (12, 13) AND left(d, 2) = '55' THEN d := substr(d, 3); END IF;
  IF length(d) IN (11, 12) AND left(d, 1) = '0' THEN d := substr(d, 2); END IF;
  IF length(d) IN (10, 11) THEN RETURN left(d, 2) || right(d, 8); END IF;
  IF length(d) >= 8 THEN RETURN d; END IF;
  RETURN NULL;
END $$;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_key text GENERATED ALWAYS AS (fp_phone_key(phone)) STORED;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS offers_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS source text;
CREATE INDEX IF NOT EXISTS idx_customers_phone_key ON customers(tenant_id, phone_key);

CREATE TABLE IF NOT EXISTS cash_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opening_cents integer NOT NULL DEFAULT 0 CHECK (opening_cents BETWEEN 0 AND 100000000),
  opened_by uuid NOT NULL REFERENCES users(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid REFERENCES users(id),
  closed_at timestamptz,
  expected_cash_cents integer,
  counted_cash_cents integer CHECK (counted_cash_cents IS NULL OR counted_cash_cents BETWEEN 0 AND 100000000),
  close_note text,
  CHECK ((status = 'open' AND closed_at IS NULL) OR (status = 'closed' AND closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_one_open ON cash_sessions(tenant_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_cash_sessions_tenant ON cash_sessions(tenant_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS cash_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  session_id uuid NOT NULL REFERENCES cash_sessions(id),
  kind text NOT NULL CHECK (kind IN ('withdrawal', 'deposit')),
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
  note text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cash_movements_session ON cash_movements(session_id);

CREATE TABLE IF NOT EXISTS sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  session_id uuid NOT NULL REFERENCES cash_sessions(id),
  sale_number integer NOT NULL,
  customer_id uuid REFERENCES customers(id),
  order_id uuid REFERENCES orders(id),
  total_cents integer NOT NULL CHECK (total_cents BETWEEN 1 AND 100000000),
  payment_method text NOT NULL CHECK (payment_method IN ('cash', 'pix', 'debit', 'credit', 'other')),
  description text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  canceled_at timestamptz,
  canceled_by uuid REFERENCES users(id),
  cancel_reason text,
  UNIQUE (tenant_id, sale_number)
);
CREATE INDEX IF NOT EXISTS idx_sales_session ON sales(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sales_tenant_day ON sales(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(tenant_id, customer_id, created_at DESC);

-- A fidelidade passa a aceitar vendas além de pedidos concluídos (mesmo cartão).
ALTER TABLE loyalty_checkins ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE loyalty_checkins ADD COLUMN IF NOT EXISTS sale_id uuid UNIQUE REFERENCES sales(id);
ALTER TABLE loyalty_checkins DROP CONSTRAINT IF EXISTS loyalty_checkins_source_check;
ALTER TABLE loyalty_checkins ADD CONSTRAINT loyalty_checkins_source_check CHECK (order_id IS NOT NULL OR sale_id IS NOT NULL);

-- Registro dos envios feitos pelo WhatsApp (clique em "Enviar"), para a lista do dia.
CREATE TABLE IF NOT EXISTS customer_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  kind text NOT NULL CHECK (kind IN ('status', 'offer')),
  sale_id uuid REFERENCES sales(id),
  campaign text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_messages ON customer_messages(tenant_id, customer_id, kind, created_at DESC);

-- Busca de nomes sem diferenciar acento e maiúscula.
CREATE OR REPLACE FUNCTION fp_fold(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT translate(lower(coalesce(p, '')), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn')
$$;
