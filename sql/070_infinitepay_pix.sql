-- Cobrança Pix pela InfinitePay (Checkout Integrado): o painel gera o QR na hora; quando a InfinitePay
-- avisa (webhook) e o pagamento é conferido no /payment_check, a venda é registrada com a forma Pix.
-- Só acréscimo. A loja só vê o recurso se houver a chave dela no servidor (INFINITEPAY_KEY_<SLUG>).
CREATE TABLE IF NOT EXISTS pix_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  description text NOT NULL DEFAULT '',
  -- Corpo da venda (como no POST /api/store/sales), guardado para registrar a venda quando o Pix cair.
  sale_body jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'canceled')),
  checkout_url text,
  invoice_slug text,
  transaction_nsu text,
  receipt_url text,
  paid_amount_cents integer,
  capture_method text,
  paid_at timestamptz,
  canceled_at timestamptz,
  canceled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  sale_id uuid UNIQUE REFERENCES sales(id) ON DELETE SET NULL,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pix_charges_tenant_open ON pix_charges (tenant_id, created_at DESC) WHERE sale_id IS NULL;
