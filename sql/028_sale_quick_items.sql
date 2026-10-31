-- Itens frequentes do caixa: botões de acesso rápido ao lançar uma venda.
-- Cada loja cadastra os seus (nome e preço opcional); ao tocar, o item entra na
-- descrição e o preço soma no valor da venda.
CREATE TABLE IF NOT EXISTS sale_quick_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  price_cents integer CHECK (price_cents IS NULL OR price_cents BETWEEN 0 AND 100000000),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sale_quick_items_label ON sale_quick_items(tenant_id, lower(label));
