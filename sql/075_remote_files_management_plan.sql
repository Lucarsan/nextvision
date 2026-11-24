-- Plano "só gestão": camera_limit 0 = loja sem câmeras (o instalador instala só o agente).
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_camera_limit_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_camera_limit_check CHECK (camera_limit BETWEEN 0 AND 128);

-- Como o PC foi instalado (relatado pelo agente 0.6.0+): 'cameras' ou 'management'.
ALTER TABLE shop_devices ADD COLUMN IF NOT EXISTS install_mode text CHECK (install_mode IN ('cameras', 'management'));

-- Arquivos à distância: a central pede, o agente do PC executa e devolve.
-- list = listar pasta; push = enviar arquivo da central para o PC; pull = trazer arquivo do PC.
-- O conteúdo do arquivo NÃO fica no banco: fica no disco temporário do servidor por até 24 h.
CREATE TABLE IF NOT EXISTS device_remote_jobs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES shop_devices(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('list', 'push', 'pull')),
  path text NOT NULL CHECK (length(path) BETWEEN 3 AND 400),
  file_name text CHECK (file_name IS NULL OR length(file_name) BETWEEN 1 AND 200),
  overwrite boolean NOT NULL DEFAULT false,
  bytes bigint,
  sha256 text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled', 'expired')),
  result jsonb,
  error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  picked_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX IF NOT EXISTS device_remote_jobs_queue ON device_remote_jobs(device_id, status, created_at);
CREATE INDEX IF NOT EXISTS device_remote_jobs_tenant ON device_remote_jobs(tenant_id, created_at DESC);
