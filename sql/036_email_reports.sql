-- Relatórios por e-mail: diário (18h), semanal (sábado 15h) e mensal (último dia 18h), no fuso da loja.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS report_email text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS report_daily boolean NOT NULL DEFAULT true;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS report_weekly boolean NOT NULL DEFAULT true;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS report_monthly boolean NOT NULL DEFAULT true;
-- Um envio por loja, tipo e período (evita duplicar quando o agendador roda mais de uma vez).
CREATE TABLE IF NOT EXISTS report_runs (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('daily', 'weekly', 'monthly')),
  period_key text NOT NULL,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'error')),
  attempts integer NOT NULL DEFAULT 1,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, period_key)
);
