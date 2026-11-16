-- Última leitura oficial das horas grátis do Render (painel Billing), para calibrar a estimativa.
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS render_free_usage jsonb;
