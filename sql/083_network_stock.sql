-- Estoque da rede (Audace): depósito central, transferências bipadas entre unidades e contagem de estoque.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS depot boolean NOT NULL DEFAULT false;
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_kind_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check CHECK (kind IN ('entry', 'sale', 'cancel', 'adjust', 'edit', 'restore', 'delete', 'transfer_out', 'transfer_in', 'count'));
CREATE TABLE IF NOT EXISTS stock_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number serial,
  network_id uuid NOT NULL REFERENCES store_networks(id),
  from_tenant uuid NOT NULL REFERENCES tenants(id),
  to_tenant uuid NOT NULL REFERENCES tenants(id),
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'received', 'divergent')),
  note text CHECK (note IS NULL OR length(note) <= 300),
  sent_by uuid REFERENCES users(id),
  sent_at timestamptz NOT NULL DEFAULT now(),
  received_by uuid REFERENCES users(id),
  received_at timestamptz,
  CHECK (from_tenant <> to_tenant)
);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_to ON stock_transfers(to_tenant, status);
CREATE TABLE IF NOT EXISTS stock_transfer_items (
  transfer_id uuid NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  from_product uuid NOT NULL REFERENCES products(id),
  to_product uuid REFERENCES products(id),
  qty_sent integer NOT NULL CHECK (qty_sent BETWEEN 1 AND 9999),
  qty_received integer CHECK (qty_received BETWEEN 0 AND 9999),
  PRIMARY KEY (transfer_id, code)
);
