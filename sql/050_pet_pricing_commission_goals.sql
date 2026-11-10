-- Pet shop (Alê Pet's, 10/11/2026):
-- 1. Cashback por dia da semana: dias em que nenhuma venda gera cashback (0=domingo … 6=sábado).
-- 2. Serviços com variáveis: preço = base + (valor da raça, se a raça do pet está na lista; senão acréscimo do porte)
--    + acréscimo da pelagem. price_rules = {"size":[{"name","cents"}],"coat":[…],"breed":[…]}.
--    addon = serviço adicional (tosa higiênica, hidratação…): base da comissão "adicionais".
-- 3. Comissão por login (vendedor/atendente): percentual sobre adicionais, serviços ou tudo.
-- 4. Metas mensais de serviços: da loja (user_id nulo) e de cada pessoa.
-- 5. Gravação por loja: desligada, nenhum vídeo é gravado nem oferecido para baixar.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cashback_off_weekdays smallint[] NOT NULL DEFAULT '{}'
  CHECK (cashback_off_weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[]);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS recordings_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS addon boolean NOT NULL DEFAULT false;
ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS price_rules jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(price_rules) = 'object');

ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS catalog_id uuid REFERENCES service_catalog(id);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS addon boolean NOT NULL DEFAULT false;

ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_percent numeric(5,2) NOT NULL DEFAULT 0
  CHECK (commission_percent >= 0 AND commission_percent <= 100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_base text NOT NULL DEFAULT 'addons'
  CHECK (commission_base IN ('addons', 'services', 'all'));

CREATE TABLE IF NOT EXISTS store_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  user_id uuid REFERENCES users(id),
  target_cents integer NOT NULL CHECK (target_cents BETWEEN 0 AND 1000000000), -- 0 = sem meta a partir deste mês
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_store_goals ON store_goals(tenant_id, month, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS idx_sale_items_service_month ON sale_items(tenant_id, sale_id) WHERE service;
