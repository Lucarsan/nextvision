ALTER TABLE orders ADD COLUMN IF NOT EXISTS share_code text;
UPDATE orders SET share_code=encode(gen_random_bytes(12),'hex') WHERE share_code IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_share_code ON orders(share_code);
ALTER TABLE orders ALTER COLUMN share_code SET DEFAULT encode(gen_random_bytes(12),'hex');
ALTER TABLE orders ALTER COLUMN share_code SET NOT NULL;
