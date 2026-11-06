-- Pagamento dividido: parte em dinheiro, parte no Pix (ou cartão...). payments = [{method, amount_cents}] somando o total cobrado.
-- Venda com uma forma só continua sem payments (NULL) e com payment_method normal; dividida fica com payment_method='mixed'.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS payments jsonb;
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_method_check;
ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check CHECK (payment_method IN ('cash', 'pix', 'debit', 'credit', 'other', 'mixed'));
