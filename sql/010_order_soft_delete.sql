ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_orders_active_by_tenant ON orders(tenant_id,created_at DESC) WHERE deleted_at IS NULL;
