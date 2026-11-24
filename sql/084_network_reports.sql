-- Resumo diário da rede por e-mail (dono, administrativo) e controle de envio.
ALTER TABLE store_networks ADD COLUMN IF NOT EXISTS report_emails text[] NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS network_report_runs (
  network_id uuid NOT NULL REFERENCES store_networks(id),
  period_key text NOT NULL,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'error')),
  attempts integer NOT NULL DEFAULT 1,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network_id, period_key)
);
