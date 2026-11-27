-- Troca/devolução: peças que voltam entram no estoque da unidade; crédito de troca separado do cashback.
-- 1) Movimento de estoque "return" (peça devolvida).
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_kind_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check CHECK (kind IN ('entry', 'sale', 'cancel', 'adjust', 'edit', 'restore', 'delete', 'transfer_out', 'transfer_in', 'count', 'return'));
-- 2) Peças devolvidas em cada atendimento (troca/devolução).
CREATE TABLE IF NOT EXISTS warranty_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES warranty_claims(id),
  sale_item_id uuid NOT NULL REFERENCES sale_items(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  product_id uuid NOT NULL REFERENCES products(id),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 9999),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_warranty_returns_item ON warranty_returns(sale_item_id);
ALTER TABLE warranty_claims ADD COLUMN IF NOT EXISTS credited_at timestamptz;
UPDATE warranty_claims SET credited_at = opened_at WHERE credit_cents IS NOT NULL AND credited_at IS NULL;
-- 3) Uso de saldo por venda: um registro de cashback e um de crédito de troca.
ALTER TABLE cashback_uses ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'cashback' CHECK (kind IN ('cashback', 'credit'));
ALTER TABLE cashback_uses DROP CONSTRAINT IF EXISTS cashback_uses_sale_id_key;
DO $$ BEGIN
  ALTER TABLE cashback_uses ADD CONSTRAINT cashback_uses_sale_kind_key UNIQUE (sale_id, kind);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
-- 4) Venda paga (parte ou tudo) com crédito de troca: total pago pode ser zero.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS credit_used_cents integer NOT NULL DEFAULT 0 CHECK (credit_used_cents >= 0);
DO $$ DECLARE c text; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'sales'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%total_cents%' AND pg_get_constraintdef(oid) LIKE '%BETWEEN%' OR (conrelid = 'sales'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%total_cents >= 1%')
  LOOP EXECUTE 'ALTER TABLE sales DROP CONSTRAINT ' || quote_ident(c); END LOOP;
END $$;
DO $$ BEGIN
  ALTER TABLE sales ADD CONSTRAINT sales_total_cents_range CHECK (total_cents BETWEEN 0 AND 100000000 AND (total_cents > 0 OR credit_used_cents > 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
