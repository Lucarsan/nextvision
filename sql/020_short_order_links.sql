-- Links curtos de acompanhamento: <dominio>/<identificador-da-loja>/<numero-do-pedido>.
-- O numero do pedido e aleatorio (4 digitos), unico entre os pedidos recentes da loja.
-- Os identificadores antigos da loja continuam valendo, para links ja enviados.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number integer;

CREATE TABLE IF NOT EXISTS tenant_slugs (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z0-9-]{3,60}$'),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tenant_slugs(slug, tenant_id) SELECT slug, id FROM tenants ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION nv_assign_order_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  candidate integer;
  attempt integer := 0;
BEGIN
  IF NEW.order_number IS NOT NULL THEN RETURN NEW; END IF;
  -- Serializa a escolha por loja para dois pedidos simultaneos nao receberem o mesmo numero.
  PERFORM pg_advisory_xact_lock(hashtext('nv-order-number:' || NEW.tenant_id::text));
  LOOP
    attempt := attempt + 1;
    IF attempt <= 60 THEN
      candidate := 1000 + floor(random() * 9000)::int;
    ELSE
      candidate := 10000 + floor(random() * 90000)::int;
    END IF;
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM orders
      WHERE tenant_id = NEW.tenant_id AND order_number = candidate
        AND created_at > now() - interval '365 days'
    );
    IF attempt > 200 THEN RAISE EXCEPTION 'order_number_exhausted'; END IF;
  END LOOP;
  NEW.order_number := candidate;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_orders_order_number ON orders;
CREATE TRIGGER trg_orders_order_number BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION nv_assign_order_number();

-- Numera pedidos existentes, um por vez, pela mesma regra.
DO $$
DECLARE r record; candidate integer;
BEGIN
  FOR r IN SELECT id, tenant_id FROM orders WHERE order_number IS NULL ORDER BY created_at LOOP
    LOOP
      candidate := 1000 + floor(random() * 9000)::int;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM orders WHERE tenant_id = r.tenant_id AND order_number = candidate);
    END LOOP;
    UPDATE orders SET order_number = candidate WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE orders ALTER COLUMN order_number SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_tenant_order_number ON orders(tenant_id, order_number, created_at DESC);
