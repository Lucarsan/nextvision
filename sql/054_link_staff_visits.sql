-- Aberturas da equipe não contam como cliente.
-- staff = a página foi aberta num navegador onde alguém da loja/central já entrou no painel.
ALTER TABLE link_visits ADD COLUMN IF NOT EXISTS staff boolean NOT NULL DEFAULT false;

-- Aparelho "de dentro": marcado como equipe, ou abriu links de clientes diferentes ou de lojas diferentes
-- (um cliente só abre os próprios pedidos). Vale também para o histórico anterior à marcação.
CREATE OR REPLACE VIEW link_insiders AS
  SELECT v.visitor_id FROM link_visits v JOIN orders o ON o.id = v.order_id
  GROUP BY v.visitor_id
  HAVING bool_or(v.staff) OR count(DISTINCT v.tenant_id) > 1
    OR count(DISTINCT COALESCE(o.customer_id::text, 'o:' || o.id::text)) > 1;

CREATE OR REPLACE VIEW link_client_visits AS
  SELECT v.* FROM link_visits v WHERE NOT EXISTS (SELECT 1 FROM link_insiders i WHERE i.visitor_id = v.visitor_id);

CREATE INDEX IF NOT EXISTS link_visits_visitor ON link_visits(visitor_id);
