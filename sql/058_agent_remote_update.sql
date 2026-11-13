-- Atualização remota do agente (scripts PowerShell) pedida pela central, por computador.
-- O pacote assinado fica em agent-releases/<versao>.json; aqui só o pedido e o último relato do PC.
ALTER TABLE shop_devices ADD COLUMN IF NOT EXISTS agent_update_target text;
ALTER TABLE shop_devices ADD COLUMN IF NOT EXISTS agent_update_request uuid;
ALTER TABLE shop_devices ADD COLUMN IF NOT EXISTS agent_update_requested_at timestamptz;
ALTER TABLE shop_devices ADD COLUMN IF NOT EXISTS agent_update_status jsonb;
ALTER TABLE shop_devices ADD COLUMN IF NOT EXISTS agent_update_status_at timestamptz;
