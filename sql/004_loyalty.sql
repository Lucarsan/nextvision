ALTER TABLE tenants ADD COLUMN IF NOT EXISTS loyalty_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS loyalty_target integer NOT NULL DEFAULT 10;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS loyalty_reward text NOT NULL DEFAULT 'Um benefício definido pela loja';
CREATE TABLE IF NOT EXISTS loyalty_checkins (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 customer_id uuid NOT NULL REFERENCES customers(id),
 order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_customer ON loyalty_checkins(tenant_id,customer_id);
