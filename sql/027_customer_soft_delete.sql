-- Exclusão de cliente pelo lojista.
-- O cliente some das listas, buscas, caixa e mensagens, mas o registro fica
-- para não quebrar pedidos, vendas e fidelidade já lançados (todos têm FK).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_customers_tenant_active ON customers(tenant_id) WHERE deleted_at IS NULL;
