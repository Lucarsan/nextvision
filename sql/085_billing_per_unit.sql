-- Mensalidade por unidade (rede): cada unidade entra na cobrança quando a central libera.
-- - billing_accounts.unit_price_cents: valor por unidade/mês (só redes). Com ele, a mensalidade da rede
--   é uma assinatura só no Asaas, de valor = unidades liberadas × valor por unidade, vencendo no due_day.
-- - tenants.billing_since: data em que a cobrança da unidade foi liberada (NULL = não cobra).
--   Mês cheio: a unidade liberada entra inteira na próxima cobrança em aberto.
-- - billing_subscriptions.per_unit/units: assinatura mantida pelo sistema (valor muda sozinho).
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS unit_price_cents integer CHECK (unit_price_cents IS NULL OR unit_price_cents >= 500);
ALTER TABLE billing_accounts ADD COLUMN IF NOT EXISTS due_day integer NOT NULL DEFAULT 20 CHECK (due_day BETWEEN 1 AND 28);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_since date;
ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS per_unit boolean NOT NULL DEFAULT false;
ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS units integer;
