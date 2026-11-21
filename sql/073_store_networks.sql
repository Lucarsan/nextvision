-- Rede de lojas: várias unidades (cada uma um tenant, com CNPJ, caixa e estoque próprios) sob uma marca.
-- - store_networks: a rede (ex.: Audace Joias), com endereço próprio (audace.ficoupronto.com), logo e cor.
-- - tenants.network_id: a unidade pertence a uma rede. Loja sem rede continua como hoje.
-- - tenants.cnpj / unit_label: dados da unidade (o CNPJ vai para a NFC-e; o rótulo aparece no painel da rede).
-- - users com role 'network': o dono da rede. Não tem tenant_id; vê todas as unidades da sua rede, sem operar o caixa.
-- Clientes e cashback compartilhados entre as unidades ficam para a próxima migração.
CREATE TABLE IF NOT EXISTS store_networks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,60}$'),
  hostname text UNIQUE CHECK (hostname IS NULL OR hostname ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  logo_url text CHECK (logo_url IS NULL OR (length(logo_url) <= 500 AND logo_url ~ '^https://')),
  brand_color text CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9a-fA-F]{6}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS network_id uuid REFERENCES store_networks(id);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cnpj text CHECK (cnpj IS NULL OR cnpj ~ '^[0-9]{14}$');
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS unit_label text CHECK (unit_label IS NULL OR char_length(unit_label) BETWEEN 1 AND 60);
CREATE INDEX IF NOT EXISTS idx_tenants_network ON tenants(network_id) WHERE network_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenants_cnpj ON tenants(cnpj) WHERE cnpj IS NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS network_id uuid REFERENCES store_networks(id);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('master', 'owner', 'operator', 'technician', 'network'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tenant_role_check;
ALTER TABLE users ADD CONSTRAINT users_tenant_role_check CHECK (
  (role IN ('master', 'technician') AND tenant_id IS NULL AND network_id IS NULL)
  OR (role IN ('owner', 'operator') AND tenant_id IS NOT NULL AND network_id IS NULL)
  OR (role = 'network' AND tenant_id IS NULL AND network_id IS NOT NULL)
);
