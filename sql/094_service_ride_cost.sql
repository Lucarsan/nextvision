-- Custo do Uber moto (ou motoboy) de um serviço: gasto da loja para buscar/levar a peça.
-- Não muda o valor cobrado do cliente; só entra no custo e abate do lucro nos relatórios.
-- O campo só aparece no caixa das lojas com ride_cost_enabled (ligado pela central/banco).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ride_cost_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS ride_cost_cents integer CHECK (ride_cost_cents IS NULL OR ride_cost_cents BETWEEN 0 AND 10000000);
