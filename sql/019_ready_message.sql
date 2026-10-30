-- Mensagem que o lojista envia pelo WhatsApp ao finalizar um pedido.
-- Variáveis: {cliente} {item} {loja} {pedido} {link}
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ready_message text NOT NULL
  DEFAULT 'Olá, {cliente}! Seu {item} está pronto para retirada na {loja}. Acompanhe: {link}'
  CHECK (char_length(ready_message) BETWEEN 10 AND 1000);
