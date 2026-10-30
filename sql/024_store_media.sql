-- Vídeo por loja: cada loja tem o próprio endereço de vídeo (túnel Cloudflare)
-- e a própria senha de leitura do MediaMTX. A senha fica criptografada (AES-GCM)
-- com uma chave que existe só no servidor; o token do túnel não é guardado:
-- é pedido à API da Cloudflare quando um computador autorizado precisa dele.
CREATE TABLE IF NOT EXISTS store_media (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  origin text NOT NULL UNIQUE CHECK (origin ~ '^https://[a-z0-9.-]{4,253}(:[0-9]{2,5})?$'),
  tunnel_id uuid UNIQUE,
  tunnel_name text,
  media_username text NOT NULL DEFAULT 'ficoupronto' CHECK (media_username ~ '^[a-z0-9_-]{3,40}$'),
  media_password_enc text NOT NULL,
  dns_record_id text,
  source text NOT NULL DEFAULT 'provisioned' CHECK (source IN ('provisioned','adopted')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Sinal de vida detalhado do computador da loja (túnel, MediaMTX, câmeras).
ALTER TABLE shop_devices ADD COLUMN IF NOT EXISTS agent_version text CHECK (agent_version IS NULL OR agent_version ~ '^[0-9A-Za-z.+-]{1,40}$');
ALTER TABLE shop_devices ADD COLUMN IF NOT EXISTS health jsonb;
ALTER TABLE shop_devices ADD COLUMN IF NOT EXISTS health_at timestamptz;
ALTER TABLE shop_devices ADD COLUMN IF NOT EXISTS provisioned_at timestamptz;
