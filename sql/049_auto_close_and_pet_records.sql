-- Encerramento automático diário: no horário escolhido pela loja (ex.: 19:00, hora de Brasília),
-- pedidos em andamento ou pausados que já começaram são finalizados e a câmera é liberada.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS auto_close_time time;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS auto_close_last_date date;

-- Prontuário do pet: vacinas, vermífugos, procedimentos, consultas e observações, com retorno/próxima dose.
CREATE TABLE IF NOT EXISTS pet_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pet_id uuid NOT NULL REFERENCES customer_pets(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('vaccine','deworming','antiparasitic','procedure','consult','exam','note')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  record_date date NOT NULL,
  next_date date,
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  done_next boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_pet_records_pet ON pet_records(tenant_id, pet_id, record_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pet_records_next ON pet_records(tenant_id, next_date) WHERE deleted_at IS NULL AND next_date IS NOT NULL AND NOT done_next;
