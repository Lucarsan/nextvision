-- Acesso só no computador da unidade (pedido da Audace, 28/11/2026).
-- Com device_lock ligado na rede, o login (quiosque, dono, supervisor, gerente) só passa com uma prova
-- de uso único que o agente Ficou Pronto do PC da unidade pede à central (ponte local 127.0.0.1:47833).
ALTER TABLE store_networks ADD COLUMN IF NOT EXISTS device_lock boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS device_login_proofs (
 proof_hash text PRIMARY KEY,
 device_id uuid NOT NULL REFERENCES shop_devices(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 used_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_device_login_proofs_expires ON device_login_proofs(expires_at);
