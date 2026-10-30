-- Fotos do estado inicial do item/servico, tiradas pelo celular ao receber o pedido.
-- Guardadas no banco (comprimidas no aparelho, ate 300 KB cada, no maximo 6 por pedido)
-- e apagadas automaticamente apos o prazo de guarda da loja (tenants.retention_days).
CREATE TABLE IF NOT EXISTS order_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  image_data bytea NOT NULL CHECK (octet_length(image_data) BETWEEN 1 AND 307200),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_photos_order ON order_photos(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_order_photos_created ON order_photos(created_at);
