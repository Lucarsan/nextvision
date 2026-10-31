-- Saídas do caixa (despesas) com forma de pagamento e categoria; movimentos podem ser cancelados.
ALTER TABLE cash_movements DROP CONSTRAINT IF EXISTS cash_movements_kind_check;
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_kind_check CHECK (kind IN ('withdrawal', 'deposit', 'expense'));
ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'cash'
  CHECK (method IN ('cash', 'pix', 'debit', 'credit', 'other'));
ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '';
ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS canceled_at timestamptz;
ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS canceled_by uuid REFERENCES users(id);
ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS cancel_reason text;
-- Sangria e suprimento são sempre dinheiro da gaveta.
ALTER TABLE cash_movements DROP CONSTRAINT IF EXISTS cash_movements_cash_only_check;
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_cash_only_check CHECK (kind = 'expense' OR method = 'cash');
