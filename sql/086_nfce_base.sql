-- NFC-e: base independente do emissor (Focus, NFE.io…). Nada é transmitido ainda.
-- Unidade (emitente): razão social, IE, regime, série/numeração, ambiente e terminal.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS legal_name text CHECK (legal_name IS NULL OR length(legal_name) BETWEEN 2 AND 120);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS state_registration text CHECK (state_registration IS NULL OR state_registration ~ '^[0-9]{2,14}$');
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tax_regime smallint NOT NULL DEFAULT 1 CHECK (tax_regime IN (1, 2, 3, 4));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS nfce_series integer NOT NULL DEFAULT 10 CHECK (nfce_series BETWEEN 0 AND 999);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS nfce_next_number integer NOT NULL DEFAULT 1 CHECK (nfce_next_number BETWEEN 1 AND 999999999);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS fiscal_env text NOT NULL DEFAULT 'homologacao' CHECK (fiscal_env IN ('homologacao', 'producao'));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS fiscal_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS payment_terminal_id text CHECK (payment_terminal_id IS NULL OR length(payment_terminal_id) BETWEEN 1 AND 40);
-- Regra fiscal padrão da rede (o que o contador definiu); o produto pode sobrescrever.
ALTER TABLE store_networks ADD COLUMN IF NOT EXISTS fiscal_defaults jsonb NOT NULL DEFAULT '{"cfop":"5102","csosn":"102","cest":"2805800","pis_cofins_cst":"08","origin":0}';
ALTER TABLE products ADD COLUMN IF NOT EXISTS cest text CHECK (cest IS NULL OR cest ~ '^[0-9]{7}$');
ALTER TABLE products ADD COLUMN IF NOT EXISTS cfop text CHECK (cfop IS NULL OR cfop ~ '^[0-9]{4}$');
ALTER TABLE products ADD COLUMN IF NOT EXISTS csosn text CHECK (csosn IS NULL OR csosn ~ '^[0-9]{3}$');
-- Dados do pagamento eletrônico (TEF/Pix) por forma: [{method, amount_cents, acquirer_cnpj, brand, auth, terminal_id, nsu}].
ALTER TABLE sales ADD COLUMN IF NOT EXISTS tef jsonb;
-- Documento fiscal de cada venda.
CREATE TABLE IF NOT EXISTS fiscal_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sale_id uuid NOT NULL REFERENCES sales(id),
  model smallint NOT NULL DEFAULT 65 CHECK (model IN (55, 65)),
  env text NOT NULL CHECK (env IN ('homologacao', 'producao')),
  series integer NOT NULL,
  number integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'authorized', 'rejected', 'canceled', 'contingency', 'error')),
  provider text,
  provider_ref text,
  access_key text CHECK (access_key IS NULL OR access_key ~ '^[0-9]{44}$'),
  protocol text,
  payload jsonb NOT NULL,
  xml_url text,
  danfe_url text,
  error text,
  econf_status text CHECK (econf_status IS NULL OR econf_status IN ('pending', 'registered', 'error')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, model, env, series, number)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_documents_sale ON fiscal_documents(sale_id, model, env) WHERE status <> 'rejected';
CREATE INDEX IF NOT EXISTS idx_fiscal_documents_tenant ON fiscal_documents(tenant_id, created_at DESC);
