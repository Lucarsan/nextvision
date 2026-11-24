-- Mensagens do quiosque (Audace): fila do dia por unidade, enviada pelo WhatsApp do próprio quiosque.
-- Contato de cada unidade (para a página "Nossas lojas" e para as mensagens).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS opening_hours text CHECK (opening_hours IS NULL OR length(opening_hours) <= 200);
-- Regras das mensagens da rede (dias para pedir avaliação, aviso de cashback, textos), editáveis por dono e supervisor.
ALTER TABLE store_networks ADD COLUMN IF NOT EXISTS message_settings jsonb NOT NULL DEFAULT '{}';
-- Campanhas da rede (Dia das Mães, Black Friday...): cada unidade envia para as clientes dela.
CREATE TABLE IF NOT EXISTS network_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network_id uuid NOT NULL REFERENCES store_networks(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 80),
  body text NOT NULL CHECK (length(body) BETWEEN 5 AND 1000),
  audience text NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'inactive_60', 'birthday_month', 'cashback_balance')),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS idx_network_campaigns_net ON network_campaigns(network_id, ends_on DESC);
CREATE INDEX IF NOT EXISTS idx_customer_messages_campaign ON customer_messages(tenant_id, campaign, created_at DESC);
