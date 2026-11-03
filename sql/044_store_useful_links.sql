-- Links úteis da loja: links rápidos, dívidas de clientes (fiado) e dados do emissor dos recibos.
-- Também guarda os atalhos do topo do painel (Caixa, Links úteis, Mensagens e os que a loja acrescentar).
CREATE TABLE IF NOT EXISTS store_links (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  url text NOT NULL,
  categories text[] NOT NULL DEFAULT '{}',
  keywords text NOT NULL DEFAULT '',
  pinned boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  clicks integer NOT NULL DEFAULT 0,
  last_opened_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_store_links_tenant ON store_links(tenant_id, position);

-- Uma "lista" por pessoa que deve à loja; cada linha é um item (o que levou, quando, valor e quanto já pagou).
CREATE TABLE IF NOT EXISTS store_debtors (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_store_debtors_tenant ON store_debtors(tenant_id, position);

CREATE TABLE IF NOT EXISTS store_debt_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  debtor_id uuid NOT NULL REFERENCES store_debtors(id) ON DELETE CASCADE,
  who text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  day date,
  amount_cents integer NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  paid_cents integer NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  done boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_store_debt_items_debtor ON store_debt_items(debtor_id, position);

-- null = atalhos padrão (Caixa, Links úteis, Mensagens).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS quick_shortcuts jsonb;
-- Emissor do recibo (nome, CPF/CNPJ, telefone, cidade e logo), igual para todos os computadores da loja.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS receipt_issuer jsonb NOT NULL DEFAULT '{}'::jsonb;
