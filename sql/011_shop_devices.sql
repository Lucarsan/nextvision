CREATE TABLE IF NOT EXISTS shop_activation_codes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 code_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 created_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_activation_tenant ON shop_activation_codes(tenant_id);
CREATE TABLE IF NOT EXISTS shop_devices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 name text NOT NULL,
 credential_hash text NOT NULL UNIQUE,
 enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz,
 revoked_at timestamptz,
 activation_id uuid UNIQUE REFERENCES shop_activation_codes(id),
 CONSTRAINT device_name_length CHECK(length(name) BETWEEN 2 AND 120)
);
CREATE INDEX IF NOT EXISTS idx_shop_devices_tenant ON shop_devices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_shop_devices_auth ON shop_devices(credential_hash);