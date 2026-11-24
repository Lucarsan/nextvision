-- Importação de planilhas (Audace): código da peça separado do nome e dados fiscais por produto.
ALTER TABLE products ADD COLUMN IF NOT EXISTS code text CHECK (code IS NULL OR length(code) BETWEEN 1 AND 64);
ALTER TABLE products ADD COLUMN IF NOT EXISTS family text CHECK (family IS NULL OR length(family) <= 80);
ALTER TABLE products ADD COLUMN IF NOT EXISTS ncm text CHECK (ncm IS NULL OR ncm ~ '^[0-9]{8}$');
ALTER TABLE products ADD COLUMN IF NOT EXISTS fiscal_origin smallint CHECK (fiscal_origin IS NULL OR fiscal_origin BETWEEN 0 AND 8);
ALTER TABLE products ADD COLUMN IF NOT EXISTS imported_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_products_tenant_code ON products(tenant_id, code) WHERE code IS NOT NULL AND active;
-- Códigos da Audace têm 1 ou 2 dígitos em algumas peças (ex.: 62); o leitor devolve exatamente o impresso.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_barcode_check;
ALTER TABLE products ADD CONSTRAINT products_barcode_check CHECK (barcode IS NULL OR barcode ~ '^[!-~]{1,64}$');
