-- Créditos do emissor de NFC-e (pacote de operações, ex.: ACBr API): comprado x usado, por rede.
CREATE TABLE IF NOT EXISTS fiscal_credit_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network_id uuid NOT NULL REFERENCES store_networks(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (length(provider) BETWEEN 2 AND 60),
  operations integer NOT NULL CHECK (operations BETWEEN 1 AND 10000000),
  price_cents integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  purchased_on date NOT NULL,
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 300),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fiscal_credit_packages_net ON fiscal_credit_packages(network_id, purchased_on);
-- Cada operação cobrada pelo emissor (emissão, cancelamento, ECONF…); "ajuste" acerta com o painel do emissor.
CREATE TABLE IF NOT EXISTS fiscal_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network_id uuid NOT NULL REFERENCES store_networks(id) ON DELETE CASCADE,
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('emissao', 'cancelamento', 'econf', 'consulta', 'outro', 'ajuste')),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN -10000000 AND 10000000),
  fiscal_document_id uuid REFERENCES fiscal_documents(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fiscal_operations_net ON fiscal_operations(network_id, created_at);
-- Avisos já mandados (85% e 100%), por total comprado: nova compra libera novos avisos.
CREATE TABLE IF NOT EXISTS fiscal_credit_alerts (
  network_id uuid NOT NULL REFERENCES store_networks(id) ON DELETE CASCADE,
  threshold integer NOT NULL,
  purchased_total integer NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network_id, threshold, purchased_total)
);
