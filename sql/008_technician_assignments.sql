ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_check;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='users'::regclass AND conname='users_role_check') THEN ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('master','owner','operator','technician')); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='users'::regclass AND conname='users_tenant_role_check') THEN ALTER TABLE users ADD CONSTRAINT users_tenant_role_check CHECK ((role IN ('master','technician') AND tenant_id IS NULL) OR (role IN ('owner','operator') AND tenant_id IS NOT NULL)); END IF; END $$;
CREATE TABLE IF NOT EXISTS technician_assignments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 technician_id uuid NOT NULL REFERENCES users(id),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 status text NOT NULL DEFAULT 'assigned' CHECK(status IN ('assigned','in_progress','completed','cancelled')),
 notes text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 UNIQUE(technician_id,tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_tech_assignments_user ON technician_assignments(technician_id,status);
