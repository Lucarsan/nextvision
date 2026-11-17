-- OS: custo e peça do estoque (a peça baixa do estoque quando o caixa recebe a OS, como no modo Serviço do caixa).
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS cost_cents integer CHECK (cost_cents IS NULL OR cost_cents BETWEEN 0 AND 100000000);
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS part_id uuid REFERENCES products(id);

-- Garantia que o cliente abre pelo link do WhatsApp (/g/<código>): cópia do que foi impresso, por OS ou por item de venda.
CREATE TABLE IF NOT EXISTS service_warranties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  token text NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{16,40}$'),
  source_kind text NOT NULL CHECK (source_kind IN ('os', 'sale_item')),
  source_id uuid NOT NULL,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_kind, source_id)
);
