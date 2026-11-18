-- Cotação de peças: preço de cada peça em cada fornecedor (ex.: Tela A01 R$ 50 na Chen, R$ 60 na ZL),
-- para pedir cada uma no mais barato. Só acréscimo. Uma linha por peça + fornecedor; lançar de novo atualiza.
CREATE TABLE IF NOT EXISTS part_quotes (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  price_cents integer NOT NULL CHECK (price_cents >= 0 AND price_cents <= 100000000),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, supplier_id)
);
CREATE INDEX IF NOT EXISTS idx_part_quotes_tenant ON part_quotes(tenant_id);

-- Peça na cotação: automático = zerada ou com reposição pendente. quote_override muda à mão:
-- true = entra mesmo assim; false = fica fora. Volta ao automático sozinho quando o estoque da peça sobe
-- (chegou compra ou a contagem aumentou).
ALTER TABLE products ADD COLUMN IF NOT EXISTS quote_override boolean;
-- Quantidade a pedir digitada na cotação (NULL = o que saiu, no mínimo 1). Também volta ao automático quando o estoque sobe.
ALTER TABLE products ADD COLUMN IF NOT EXISTS quote_qty integer CHECK (quote_qty IS NULL OR quote_qty BETWEEN 1 AND 9999);
CREATE OR REPLACE FUNCTION fp_quote_override_reset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stock_qty IS NOT NULL AND NEW.stock_qty > coalesce(OLD.stock_qty, 0) THEN NEW.quote_override := NULL; NEW.quote_qty := NULL; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_products_quote_override_reset ON products;
CREATE TRIGGER trg_products_quote_override_reset BEFORE UPDATE OF stock_qty ON products FOR EACH ROW EXECUTE FUNCTION fp_quote_override_reset();
