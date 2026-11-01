-- Backups cifrados de cada loja guardados no computador da loja (agente Windows).
-- O arquivo só é legível pelo servidor (chave fora da loja); aqui fica só o registro de cada envio.
CREATE TABLE IF NOT EXISTS store_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  device_id uuid REFERENCES shop_devices(id),
  bytes integer NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  rows_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  saved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_store_backups_tenant ON store_backups(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_backups_device ON store_backups(device_id, created_at DESC);
