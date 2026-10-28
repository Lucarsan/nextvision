-- Operação do painel Premium Flow
ALTER TABLE orders ADD COLUMN IF NOT EXISTS queue_rank bigint;
CREATE INDEX IF NOT EXISTS idx_orders_queue ON orders(tenant_id,status,queue_rank,created_at);
CREATE TABLE IF NOT EXISTS tenant_logos (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
 mime_type text NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')),
 image_data bytea NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT logo_max_size CHECK(octet_length(image_data)<=262144)
);
