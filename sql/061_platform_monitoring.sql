-- Monitoramento da plataforma: alertas abertos/resolvidos e para onde avisar.
CREATE TABLE IF NOT EXISTS platform_alerts (
  key text PRIMARY KEY,
  severity text NOT NULL CHECK (severity IN ('info','warn','critical')),
  category text NOT NULL,
  title text NOT NULL,
  detail text NOT NULL DEFAULT '',
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  notified_at timestamptz,
  notified_severity text,
  acknowledged_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_platform_alerts_open ON platform_alerts(status, severity);
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS alert_email text CHECK (alert_email IS NULL OR char_length(alert_email) <= 200);
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS telegram_chat_id text CHECK (telegram_chat_id IS NULL OR telegram_chat_id ~ '^-?[0-9]{1,20}$');
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS alert_digest_date date;
