ALTER TABLE cameras ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES shop_devices(id);
CREATE INDEX IF NOT EXISTS cameras_device_tenant_idx ON cameras(device_id,tenant_id);
CREATE INDEX IF NOT EXISTS recording_jobs_idx ON recordings(tenant_id,camera_id,status);