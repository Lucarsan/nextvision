-- Cobrança das lojas pelo Asaas (só acréscimo; a tabela antiga "invoices" fica como está, vazia).
-- - billing_accounts: quem paga. Uma loja avulsa (tenant_id) OU uma rede inteira (network_id, ex.: Audace).
--   mode: charge = cobra e pode bloquear; exempt = nunca cobra nem bloqueia (ex.: ELITECH);
--         paused = cadastro guardado, sem cobranças novas nem bloqueio.
--   grace_days: dias depois do vencimento até bloquear. block_override_until: a central liberou até essa data.
-- - billing_subscriptions: mensalidade recorrente (assinatura no Asaas, que gera as cobranças mês a mês).
-- - billing_charges: cada cobrança do Asaas (avulsa, parcela de implantação ou mês da assinatura).
-- - billing_events: avisos (webhook) já recebidos, para não processar duas vezes.
-- - tenants.billing_prev_status / store_networks.billing_blocked: bloqueio feito pela cobrança,
--   para liberar sozinho quando pagar sem desfazer suspensões manuais.
CREATE TABLE IF NOT EXISTS billing_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  network_id uuid UNIQUE REFERENCES store_networks(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  cpf_cnpj text CHECK (cpf_cnpj IS NULL OR cpf_cnpj ~ '^([0-9]{11}|[0-9]{14})$'),
  email text CHECK (email IS NULL OR char_length(email) <= 200),
  phone text CHECK (phone IS NULL OR phone ~ '^[0-9]{10,13}$'),
  mode text NOT NULL DEFAULT 'charge' CHECK (mode IN ('charge', 'exempt', 'paused')),
  grace_days integer NOT NULL DEFAULT 5 CHECK (grace_days BETWEEN 0 AND 60),
  auto_block boolean NOT NULL DEFAULT true,
  billing_type text NOT NULL DEFAULT 'UNDEFINED' CHECK (billing_type IN ('UNDEFINED', 'PIX', 'BOLETO')),
  asaas_customer_id text UNIQUE,
  blocked_at timestamptz,
  block_override_until date,
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((tenant_id IS NULL) <> (network_id IS NULL))
);

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
  description text NOT NULL CHECK (char_length(description) BETWEEN 2 AND 200),
  value_cents integer NOT NULL CHECK (value_cents >= 500),
  first_due_date date NOT NULL,
  end_date date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled')),
  asaas_subscription_id text UNIQUE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  canceled_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_billing_subs_account ON billing_subscriptions(account_id);

CREATE TABLE IF NOT EXISTS billing_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES billing_subscriptions(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'other' CHECK (kind IN ('setup', 'monthly', 'other')),
  description text NOT NULL DEFAULT '',
  value_cents integer NOT NULL CHECK (value_cents >= 0),
  due_date date NOT NULL,
  -- Situação como o Asaas devolve (PENDING, OVERDUE, RECEIVED, CONFIRMED, RECEIVED_IN_CASH, REFUNDED…).
  status text NOT NULL DEFAULT 'PENDING',
  deleted boolean NOT NULL DEFAULT false,
  asaas_payment_id text UNIQUE,
  invoice_url text,
  bank_slip_url text,
  billing_type text,
  paid_at date,
  paid_value_cents integer,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_billing_charges_account ON billing_charges(account_id, due_date DESC);
CREATE INDEX IF NOT EXISTS idx_billing_charges_open ON billing_charges(due_date) WHERE NOT deleted AND status IN ('PENDING', 'OVERDUE');

CREATE TABLE IF NOT EXISTS billing_events (
  id text PRIMARY KEY,
  event text NOT NULL,
  payment_id text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text
);

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_prev_status text CHECK (billing_prev_status IS NULL OR billing_prev_status IN ('trial', 'active'));
ALTER TABLE store_networks ADD COLUMN IF NOT EXISTS billing_blocked boolean NOT NULL DEFAULT false;

ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS billing_last_sync_at timestamptz;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS billing_last_sync_error text;
