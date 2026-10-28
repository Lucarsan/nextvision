-- Pedidos de cadastro rápido e infraestrutura para futuras integrações ERP
ALTER TABLE orders ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_reference text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_external_reference ON orders(tenant_id,source,external_reference) WHERE external_reference IS NOT NULL;
CREATE TABLE IF NOT EXISTS integration_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 provider text NOT NULL,
 status text NOT NULL DEFAULT 'not_connected' CHECK(status IN ('not_connected','pending','connected','error','disabled')),
 settings jsonb NOT NULL DEFAULT '{}'::jsonb,
 last_synced_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,provider)
);
-- Nunca armazenar credenciais de integrações em settings; usar armazenamento seguro separado.
