-- Ordens de serviço (OS) da assistência técnica: o aparelho fica na loja para orçar ou consertar.
-- Situações: quote (orçamento pendente: falta orçar/falar com o cliente) → queue (fila de serviços) →
-- done (concluído: chamar o cliente) → delivered (entregue: a garantia conta a partir daqui).
-- canceled: OS lançada errado. Orçamento recusado vai para done com repaired=false (devolver o aparelho, sem garantia).
-- Com valor e fora do orçamento, a OS tem uma venda "A receber" (pending_sale_id): o caixa recebe por ela.
CREATE TABLE IF NOT EXISTS service_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  number integer NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id),
  device_type text NOT NULL DEFAULT 'Celular' CHECK (length(device_type) <= 40),
  brand text NOT NULL DEFAULT '' CHECK (length(brand) <= 60),
  model text NOT NULL DEFAULT '' CHECK (length(model) <= 80),
  serial text NOT NULL DEFAULT '' CHECK (length(serial) <= 60),
  color text NOT NULL DEFAULT '' CHECK (length(color) <= 40),
  accessories text NOT NULL DEFAULT '' CHECK (length(accessories) <= 200),
  condition text NOT NULL DEFAULT '' CHECK (length(condition) <= 500),
  problem text NOT NULL DEFAULT '' CHECK (length(problem) <= 500),
  service text NOT NULL DEFAULT '' CHECK (length(service) <= 300),
  price_cents integer NOT NULL DEFAULT 0 CHECK (price_cents BETWEEN 0 AND 100000000),
  due_on date,
  warranty_days integer NOT NULL DEFAULT 90 CHECK (warranty_days BETWEEN 0 AND 3650),
  status text NOT NULL DEFAULT 'queue' CHECK (status IN ('quote', 'queue', 'done', 'delivered', 'canceled')),
  repaired boolean NOT NULL DEFAULT true,
  stage text NOT NULL DEFAULT '' CHECK (length(stage) <= 60),
  stage_note text NOT NULL DEFAULT '' CHECK (length(stage_note) <= 300),
  pending_sale_id uuid REFERENCES pending_sales(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  quoted_at timestamptz,
  done_at timestamptz,
  delivered_at timestamptz,
  notified_at timestamptz,
  canceled_at timestamptz,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 200),
  UNIQUE (tenant_id, number)
);
CREATE INDEX IF NOT EXISTS idx_service_orders_open ON service_orders(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_service_orders_pending ON service_orders(pending_sale_id) WHERE pending_sale_id IS NOT NULL;

-- Padrões da loja para a OS: garantia, termos impressos e mensagens de WhatsApp ({cliente}, {loja}, {os}, {aparelho}, {servico}, {valor}).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS os_warranty_days integer NOT NULL DEFAULT 90 CHECK (os_warranty_days BETWEEN 0 AND 3650);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS os_warranty_terms text NOT NULL DEFAULT '' CHECK (length(os_warranty_terms) <= 1500);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS os_ready_message text NOT NULL DEFAULT '' CHECK (length(os_ready_message) <= 1000);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS os_quote_message text NOT NULL DEFAULT '' CHECK (length(os_quote_message) <= 1000);
