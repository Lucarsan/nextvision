ALTER TABLE recordings ADD COLUMN IF NOT EXISTS camera_id uuid REFERENCES cameras(id);
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES shop_devices(id);
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS error_message text;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS recordings_one_per_step ON recordings(order_id,step_index);
CREATE INDEX IF NOT EXISTS recordings_tenant_order ON recordings(tenant_id,order_id,step_index);