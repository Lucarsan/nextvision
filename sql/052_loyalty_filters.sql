-- Fidelidade com filtros (Alê Pet's, 10/11/2026): "a cada 10 banhos, uma hidratação; banho de quarta (promoção) não conta".
-- loyalty_off_weekdays: dias em que nenhum atendimento/compra soma ponto (0=domingo … 6=sábado).
-- loyalty_service_ids: serviços do cadastro que somam ponto. Vazio = qualquer atendimento/compra soma (como antes).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS loyalty_off_weekdays smallint[] NOT NULL DEFAULT '{}'
  CHECK (loyalty_off_weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[]);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS loyalty_service_ids uuid[] NOT NULL DEFAULT '{}';
