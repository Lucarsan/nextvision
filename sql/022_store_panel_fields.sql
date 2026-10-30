-- Cadastro de cliente mais completo, cidade da loja (para sugerir endereços),
-- mensagens de WhatsApp por acao e novo nicho de funilaria.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS cpf text CHECK (cpf IS NULL OR cpf ~ '^[0-9]{11}$');
ALTER TABLE customers ADD COLUMN IF NOT EXISTS birth_date date;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS postal_code text CHECK (postal_code IS NULL OR postal_code ~ '^[0-9]{8}$');
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS state text CHECK (state IS NULL OR state ~ '^[A-Z]{2}$');
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS message_templates jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_customers_tenant_name ON customers(tenant_id, lower(name));
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_niche_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_niche_check CHECK (niche IN ('general','automotive','bodyshop','carwash','electronics','pet','food'));
