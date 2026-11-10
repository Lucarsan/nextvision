-- Vendas a receber: o cliente deixa o pet (ou leva algo) e paga depois. A venda fica guardada (itens, cliente,
-- vendedor, pedido); ao receber vira uma venda normal no caixa aberto (paid_sale_id). Cancelar não apaga.
CREATE TABLE IF NOT EXISTS pending_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  number integer NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id),
  order_id uuid REFERENCES orders(id),
  seller_id uuid REFERENCES users(id),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  total_cents integer NOT NULL CHECK (total_cents BETWEEN 1 AND 100000000),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_sale_id uuid UNIQUE REFERENCES sales(id),
  paid_at timestamptz,
  canceled_at timestamptz,
  canceled_by uuid REFERENCES users(id),
  cancel_reason text CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 200),
  UNIQUE (tenant_id, number)
);
CREATE INDEX IF NOT EXISTS idx_pending_sales_open ON pending_sales(tenant_id, created_at) WHERE paid_sale_id IS NULL AND canceled_at IS NULL;
