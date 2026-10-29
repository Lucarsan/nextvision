ALTER TABLE cameras ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS cameras_available_by_tenant ON cameras(tenant_id) WHERE enabled AND deleted_at IS NULL;
