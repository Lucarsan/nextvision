-- Acessos da rede e redefinição de senha.
-- - users.network_access: 'owner' (dono: a rede toda) ou 'supervisor' (só as unidades em network_unit_ids).
-- - password_resets: link de nova senha enviado por e-mail. Guarda só o hash do código, vale 1 hora e é usado uma vez.
ALTER TABLE users ADD COLUMN IF NOT EXISTS network_access text NOT NULL DEFAULT 'owner' CHECK (network_access IN ('owner', 'supervisor'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS network_unit_ids uuid[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  requested_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id, created_at DESC);

-- Troca de senha encerra as sessões abertas antes dela (o token de login guarda a hora em que foi emitido).
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
