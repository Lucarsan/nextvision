-- Dono liberado da senha do admin (metas, relatórios, valor do estoque, editar produto, preços em lote).
-- Ligado por usuário, só vale para role 'owner'. Primeiro uso: donos da Alê Pet's.
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_password_free boolean NOT NULL DEFAULT false;
