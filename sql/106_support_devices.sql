-- PC de suporte (28/11/2026): o PC do suporte, com o agente ativado em qualquer loja, entra pelo login normal
-- (senha da unidade ou login próprio) em qualquer unidade travada e na gestão da rede. Só a central marca.
ALTER TABLE shop_devices ADD COLUMN IF NOT EXISTS support boolean NOT NULL DEFAULT false;
