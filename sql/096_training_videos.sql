-- Vídeos de treinamento (Audace, 26/11/2026): vídeo guardado no Cloudflare R2, aberto só por quem está logado.
-- Quem assistiu: vendedora pelo PIN no quiosque; supervisor e dono pelo login do painel da rede.
-- seen: um caractere por trecho de 5 segundos ('1' = assistido de verdade, tocando; arrastar a barra não conta).
CREATE TABLE IF NOT EXISTS training_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network_id uuid REFERENCES store_networks(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  description text CHECK (description IS NULL OR length(description) <= 600),
  object_key text CHECK (object_key IS NULL OR length(object_key) BETWEEN 1 AND 400),
  url text CHECK (url IS NULL OR url ~ '^https://'),
  duration_s integer NOT NULL CHECK (duration_s BETWEEN 5 AND 14400),
  chapters jsonb NOT NULL DEFAULT '[]',
  audiences text[] NOT NULL DEFAULT ARRAY['seller', 'supervisor', 'owner'],
  version integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (object_key IS NOT NULL OR url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS training_videos_network ON training_videos(network_id);

CREATE TABLE IF NOT EXISTS training_views (
  video_id uuid NOT NULL REFERENCES training_videos(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version integer NOT NULL,
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  seen text NOT NULL DEFAULT '',
  position integer NOT NULL DEFAULT 0,
  percent smallint NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_ping_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (video_id, user_id, version)
);
CREATE INDEX IF NOT EXISTS training_views_user ON training_views(user_id);
