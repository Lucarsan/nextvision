-- Supervisor confere o fechamento do caixa (Anexo II): quem conferiu, quando e observação.
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id);
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS review_note text CHECK (review_note IS NULL OR length(review_note) <= 300);
CREATE INDEX IF NOT EXISTS idx_cash_sessions_unreviewed ON cash_sessions(tenant_id, closed_at) WHERE status = 'closed' AND reviewed_at IS NULL;
