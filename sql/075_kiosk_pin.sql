-- Acesso por quiosque e PIN das vendedoras (Audace).
-- - users.login_kind: 'email' (entra com e-mail e senha), 'pin' (vendedora: não tem login, só confirma a venda
--   com o PIN no caixa do quiosque) ou 'kiosk' (o computador do quiosque, aberto com a senha da unidade).
-- - users.pin_hash: PIN de 4 dígitos (hash). Vendedora confirma a venda; dono/supervisor autoriza cancelamento.
-- - tenants.pin_sales: a venda exige vendedora + PIN (unidades de rede).
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_kind text NOT NULL DEFAULT 'email' CHECK (login_kind IN ('email', 'pin', 'kiosk'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS pin_sales boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_kiosk_per_tenant ON users(tenant_id) WHERE login_kind = 'kiosk';
