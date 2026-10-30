-- Excluir processo sem perder o histórico dos pedidos (arquiva), chamados de suporte
-- abertos pelo lojista e WhatsApp do suporte da central.
ALTER TABLE processes ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS support_whatsapp text CHECK (support_whatsapp IS NULL OR support_whatsapp ~ '^[0-9]{10,15}$');
CREATE TABLE IF NOT EXISTS support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN ('video','camera','pedidos','acesso','cobranca','outro')),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 3 AND 140),
  description text NOT NULL CHECK (char_length(description) BETWEEN 5 AND 4000),
  contact_phone text CHECK (contact_phone IS NULL OR char_length(contact_phone) <= 30),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  central_note text CHECK (central_note IS NULL OR char_length(central_note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_tenant ON support_tickets(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status, created_at DESC);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS whatsapp text CHECK (whatsapp IS NULL OR whatsapp ~ '^[0-9]{10,15}$');
