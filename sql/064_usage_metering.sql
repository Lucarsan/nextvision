-- Uso medido por loja, por dia (fuso de Fortaleza), para ratear os custos da plataforma.
-- subject = id da loja, ou 'platform' para o que não é de nenhuma loja (central, rotinas, monitoramento).
CREATE TABLE IF NOT EXISTS tenant_usage_daily (
  day date NOT NULL,
  subject text NOT NULL CHECK (subject = 'platform' OR subject ~ '^[0-9a-f-]{36}$'),
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  requests integer NOT NULL DEFAULT 0,
  bytes_out bigint NOT NULL DEFAULT 0,
  db_queries integer NOT NULL DEFAULT 0,
  db_ms double precision NOT NULL DEFAULT 0,
  active_slots integer NOT NULL DEFAULT 0,      -- janelas de 5 min em que a loja usou o banco
  slot_share double precision NOT NULL DEFAULT 0, -- mesma coisa, dividindo cada janela entre quem a usou
  PRIMARY KEY (day, subject)
);
CREATE INDEX IF NOT EXISTS idx_tenant_usage_daily_tenant ON tenant_usage_daily(tenant_id, day);

-- Grupo de cobrança: lojas do mesmo dono somam juntas no rateio (vazio = a loja sozinha).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_group text CHECK (billing_group IS NULL OR char_length(billing_group) BETWEEN 1 AND 80);

-- Custos fixos mensais que a central quer ratear (ex.: chip/internet por câmera, domínio, ferramentas)
-- e a cotação usada para mostrar em reais.
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS cost_items jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS usd_brl numeric(8,4) NOT NULL DEFAULT 5.50 CHECK (usd_brl > 0 AND usd_brl < 100);

-- E-mail de alerta crítico: no máximo um por problema por dia (evita e-mails repetidos quando oscila).
ALTER TABLE platform_alerts ADD COLUMN IF NOT EXISTS emailed_on date;
