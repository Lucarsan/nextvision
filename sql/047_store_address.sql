-- Endereço da loja (rua, número e bairro), mostrado no topo do link do cliente e editado em
-- Configurações → Perfil. A cidade e a UF continuam em city/state.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS address text CHECK (address IS NULL OR length(address) <= 160);
