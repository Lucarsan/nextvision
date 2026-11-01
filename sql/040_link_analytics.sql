-- Medição do acompanhamento (anônima): cada abertura do link do pedido vira uma "visita".
-- visitor_id é um número aleatório guardado no aparelho do cliente (sem IP, nome ou telefone).
-- A página envia um sinal a cada ~30 s com o tempo visível e o tempo assistindo ao vivo (acumulados).
CREATE TABLE IF NOT EXISTS link_visits (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  visitor_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  visible_seconds integer NOT NULL DEFAULT 0 CHECK (visible_seconds >= 0),
  live_seconds integer NOT NULL DEFAULT 0 CHECK (live_seconds >= 0),
  device text NOT NULL DEFAULT 'other' CHECK (device IN ('mobile', 'tablet', 'desktop', 'other')),
  source text NOT NULL DEFAULT 'direct' CHECK (source IN ('whatsapp', 'qrcode', 'direct', 'other'))
);
CREATE INDEX IF NOT EXISTS link_visits_tenant_time ON link_visits(tenant_id, started_at);
CREATE INDEX IF NOT EXISTS link_visits_order ON link_visits(order_id, visitor_id);

-- Ações: link enviado/copiado pela loja, vídeo baixado, conversa com a loja, recompensa pedida.
CREATE TABLE IF NOT EXISTS link_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  kind text NOT NULL CHECK (kind IN ('link_sent', 'link_copied', 'video_download', 'talk_store', 'loyalty_claim')),
  visitor_id uuid,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS link_events_tenant_time ON link_events(tenant_id, created_at, kind);
CREATE INDEX IF NOT EXISTS link_events_order ON link_events(order_id, kind);

-- Números públicos (site/apresentação): desligado até a central decidir mostrar.
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS public_stats_enabled boolean NOT NULL DEFAULT false;
-- Modelo da mensagem de resultados que a central envia aos lojistas pelo WhatsApp.
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS store_report_template text CHECK (store_report_template IS NULL OR length(store_report_template) <= 2000);

-- Programação do relatório de resultados por loja (enviado pela central): desligado, diário ou semanal.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS results_report text NOT NULL DEFAULT 'weekly' CHECK (results_report IN ('off', 'daily', 'weekly'));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS results_report_weekday integer NOT NULL DEFAULT 1 CHECK (results_report_weekday BETWEEN 0 AND 6);
CREATE TABLE IF NOT EXISTS results_report_sends (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  period_key text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  sent_by uuid REFERENCES users(id),
  PRIMARY KEY (tenant_id, period_key)
);
