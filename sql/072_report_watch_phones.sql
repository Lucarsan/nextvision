-- Relatório mensal: clientes cujas compras saem numa seção à parte (ex.: o dono pega itens do estoque e o
-- vendedor lança a venda para ele). Guarda só os dígitos do telefone; a busca compara os últimos 8 dígitos.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS report_watch_phones text[] NOT NULL DEFAULT '{}';
