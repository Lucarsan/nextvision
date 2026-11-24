-- Cadastro único de clientes na rede (Audace): cada unidade guarda a sua ficha da cliente,
-- e as fichas da mesma pessoa nas unidades da rede compartilham o mesmo link_id.
-- O cashback vale em qualquer unidade: o saldo soma os lotes de todas as fichas ligadas.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS link_id uuid;
CREATE INDEX IF NOT EXISTS idx_customers_link ON customers(link_id) WHERE link_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_tenant_cpf ON customers(tenant_id, cpf) WHERE cpf IS NOT NULL AND deleted_at IS NULL;
