ALTER TABLE loyalty_checkins ADD COLUMN IF NOT EXISTS redemption_id uuid;
CREATE TABLE IF NOT EXISTS loyalty_redemptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 customer_id uuid NOT NULL REFERENCES customers(id),
 code_hash text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'issued' CHECK(status IN ('issued','redeemed')),
 target_snapshot integer NOT NULL,
 reward_snapshot text NOT NULL,
 issued_at timestamptz NOT NULL DEFAULT now(),
 redeemed_at timestamptz,
 redeemed_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_customer ON loyalty_redemptions(tenant_id,customer_id,issued_at DESC);
