-- Parcelas do crédito na venda (vale também para a maquininha avulsa, enquanto o TEF não está ligado).
ALTER TABLE sales ADD COLUMN IF NOT EXISTS installments smallint NOT NULL DEFAULT 1 CHECK (installments BETWEEN 1 AND 24);
