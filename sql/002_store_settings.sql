ALTER TABLE customers ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS logo_url text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS email_notifications text NOT NULL DEFAULT 'off';
