-- Avaliações do Google: medir quantos clientes abriram o link de avaliação que a loja mandou.
--
-- A mensagem de status passa a levar um link nosso por cliente (/a/<código>), que registra o clique e
-- redireciona para o link de avaliação da loja. Como o código vai no texto, vale também para a
-- mensagem copiada e colada à mão no WhatsApp.
-- O Google não informa de onde veio cada avaliação: o que medimos é quem abriu o link. A central pode
-- marcar à mão os clientes que de fato avaliaram (conferindo o nome no Google).

ALTER TABLE customers ADD COLUMN IF NOT EXISTS review_code text;
UPDATE customers SET review_code = substr(md5(gen_random_uuid()::text), 1, 10) WHERE review_code IS NULL;
ALTER TABLE customers ALTER COLUMN review_code SET DEFAULT substr(md5(gen_random_uuid()::text), 1, 10);
ALTER TABLE customers ALTER COLUMN review_code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customers_review_code ON customers(review_code);

-- Avaliação conferida no Google (marcada pela central).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS review_confirmed_at timestamptz;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS review_confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- A mensagem enviada levava o link de avaliação?
ALTER TABLE customer_messages ADD COLUMN IF NOT EXISTS review_link boolean NOT NULL DEFAULT false;

-- source: message = link da mensagem (/a/<código>); order_page = botão "Avaliar no Google" da página do pedido.
-- staff: navegador onde alguém já entrou no painel.
CREATE TABLE IF NOT EXISTS review_clicks (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('message', 'order_page')),
  visitor_id uuid,
  staff boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_clicks_tenant_at ON review_clicks(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS review_clicks_customer ON review_clicks(customer_id);

-- Cliques de clientes: fora os da equipe (marcados, aparelhos "de dentro" do acompanhamento
-- ou aparelhos que abriram links de avaliação de clientes diferentes).
CREATE OR REPLACE VIEW review_client_clicks AS
  SELECT c.* FROM review_clicks c
  WHERE NOT c.staff
    AND (c.visitor_id IS NULL OR (
      NOT EXISTS (SELECT 1 FROM link_insiders i WHERE i.visitor_id = c.visitor_id)
      AND NOT EXISTS (SELECT 1 FROM review_clicks o WHERE o.visitor_id = c.visitor_id
        AND (o.staff OR COALESCE(o.customer_id::text, '') <> COALESCE(c.customer_id::text, '')))));
