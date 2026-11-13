-- Envio do link na criação do pedido: a loja pode registrar por que não enviou.
-- 'link_skipped' com motivo: cliente sem WhatsApp, enviado de outro jeito ou "depois" (continua pendente).
ALTER TABLE link_events DROP CONSTRAINT IF EXISTS link_events_kind_check;
ALTER TABLE link_events ADD CONSTRAINT link_events_kind_check
  CHECK (kind IN ('link_sent', 'link_copied', 'video_download', 'talk_store', 'loyalty_claim', 'link_skipped'));
ALTER TABLE link_events ADD COLUMN IF NOT EXISTS note text CHECK (note IS NULL OR note IN ('no_whatsapp', 'other_way', 'later'));
