-- TEF Stone: resposta do estorno no pinpad (POST /api/Cancel/ do Slim).
-- A homologação da Stone pede, para cada estorno, data e hora, ATK e comprovante do próprio estorno.
-- reversal_response: a resposta como veio, sem as vias (que ficam em reversal_receipt).
ALTER TABLE tef_transactions ADD COLUMN IF NOT EXISTS reversal_response jsonb;
ALTER TABLE tef_transactions ADD COLUMN IF NOT EXISTS reversal_receipt text CHECK (reversal_receipt IS NULL OR length(reversal_receipt) <= 8000);
