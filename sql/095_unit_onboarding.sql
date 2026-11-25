-- Implantação por unidade (checklist "unidade pronta" da Audace).
-- Itens automáticos são calculados a partir dos dados reais; aqui ficam só as marcações manuais
-- (feito / aguardando a rede / não se aplica), com quem marcou e quando, e o aceite da unidade.
CREATE TABLE IF NOT EXISTS unit_onboarding_marks (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item text NOT NULL CHECK (item ~ '^[a-z_]{2,40}$'),
  state text NOT NULL CHECK (state IN ('done', 'waiting', 'na')),
  note text CHECK (note IS NULL OR length(note) <= 300),
  marked_by uuid REFERENCES users(id),
  marked_by_name text,
  marked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item)
);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS onboarding_accepted_at timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS onboarding_accepted_by uuid REFERENCES users(id);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS onboarding_accepted_name text;
