-- Cancelamento da NFC-e junto com a venda (prazo da SEFAZ: 30 minutos). Guarda o evento sem apagar a autorização.
ALTER TABLE fiscal_documents ADD COLUMN IF NOT EXISTS canceled_at timestamptz;
ALTER TABLE fiscal_documents ADD COLUMN IF NOT EXISTS cancel_protocol text;
ALTER TABLE fiscal_documents ADD COLUMN IF NOT EXISTS cancel_response jsonb;
