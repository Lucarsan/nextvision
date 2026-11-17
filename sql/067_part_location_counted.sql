-- Peças (telas…): onde ficam guardadas e conferência da quantidade.
-- - location: lugar na loja ("Caixa 01"), para achar a peça e conferir caixa por caixa.
-- - counted_at / counted_by: última vez que alguém contou e confirmou a quantidade (aba Peças → "Conferir").
ALTER TABLE products ADD COLUMN IF NOT EXISTS location text CHECK (location IS NULL OR length(location) <= 40);
ALTER TABLE products ADD COLUMN IF NOT EXISTS counted_at timestamptz;
ALTER TABLE products ADD COLUMN IF NOT EXISTS counted_by uuid REFERENCES users(id);
