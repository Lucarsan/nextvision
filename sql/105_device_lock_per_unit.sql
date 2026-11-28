-- Trava por unidade (28/11/2026): ligar a trava da rede inteira derrubava as unidades ainda sem o agente.
-- tenants.device_lock: caixa do quiosque e logins da própria loja (gerente/operador) só no PC desta unidade.
-- store_networks.device_lock passa a valer só para a gestão da rede (dono e supervisores), em PC de qualquer unidade.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS device_lock boolean NOT NULL DEFAULT false;
