-- Vendedor da venda: escolhido no caixa entre os logins ativos da loja (cadastrados na central).
-- Vendas antigas ficam sem vendedor (o relatório usa quem registrou).
ALTER TABLE sales ADD COLUMN IF NOT EXISTS seller_id uuid REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_sales_tenant_seller ON sales(tenant_id, created_at DESC) WHERE seller_id IS NOT NULL;
