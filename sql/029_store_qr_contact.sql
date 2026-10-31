-- QR code de atendimento: o cliente informa nome e WhatsApp, entra no cadastro
-- da loja (source = 'qrcode') e é levado ao WhatsApp da loja com esta mensagem.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS qr_message text;
