-- Log de estoque: toda mudança fica registrada com o saldo antes e depois e uma observação.
-- Novos tipos: 'edit' (quantidade trocada no cadastro), 'restore' (produto reativado), 'delete' (produto ou modelo excluído).
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS stock_before integer;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS stock_after integer;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_kind_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check CHECK (kind IN ('entry', 'sale', 'cancel', 'adjust', 'edit', 'restore', 'delete'));
CREATE INDEX IF NOT EXISTS idx_stock_movements_product_time ON stock_movements(product_id, created_at);

-- Fila de etiquetas: produtos cadastrados em dias diferentes são impressos juntos na mesma folha.
ALTER TABLE products ADD COLUMN IF NOT EXISTS labels_pending integer NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS labels_queued_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_products_labels_pending ON products(tenant_id) WHERE labels_pending > 0;
