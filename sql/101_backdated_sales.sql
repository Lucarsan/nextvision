-- Venda lançada depois (boleta do período sem sistema): fica com a data em que aconteceu, fora do caixa de hoje,
-- sem pinpad, sem NFC-e e sem cashback. Marca quem lançou e quando.
ALTER TABLE sales ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS backdated_at timestamptz;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS backdated_by uuid REFERENCES users(id);
DO $$ BEGIN
  ALTER TABLE sales ADD CONSTRAINT sales_session_or_backdated CHECK (session_id IS NOT NULL OR backdated_at IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_sales_backdated ON sales(tenant_id, backdated_at DESC) WHERE backdated_at IS NOT NULL;
