-- Pinpad fora do ar (IN 87/2025): a venda é paga na maquininha avulsa e fica pendente de conciliação (evento ECONF).
ALTER TABLE sales ADD COLUMN IF NOT EXISTS offline_payment boolean NOT NULL DEFAULT false;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS offline_auth text CHECK (offline_auth IS NULL OR length(offline_auth) <= 40);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS econf_done_at timestamptz;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS econf_done_by uuid REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_sales_econf_pending ON sales(tenant_id, created_at) WHERE offline_payment AND econf_done_at IS NULL AND canceled_at IS NULL;
