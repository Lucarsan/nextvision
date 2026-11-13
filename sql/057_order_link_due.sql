-- "Link não enviado" vale só daqui pra frente: pedidos criados antes desta migração ficam dispensados.
-- Exceção (no painel): pedido de cliente com venda em "A receber" aberta continua cobrando o envio (o pet ainda está na loja).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS link_due boolean NOT NULL DEFAULT true;
UPDATE orders SET link_due = false WHERE link_due;
