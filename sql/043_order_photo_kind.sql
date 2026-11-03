-- Foto final: a loja fotografa o resultado ao concluir (ex.: o pet depois do banho).
-- 'arrival' = como chegou (ate 6); 'final' = resultado (ate 3). As fotos existentes sao de entrada.
ALTER TABLE order_photos ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'arrival';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_photos_kind_check') THEN
    ALTER TABLE order_photos ADD CONSTRAINT order_photos_kind_check CHECK (kind IN ('arrival','final'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_order_photos_order_kind ON order_photos(order_id, kind, created_at);
