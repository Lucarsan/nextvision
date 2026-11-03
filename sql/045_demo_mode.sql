-- (045) Modo demonstração: a loja marcada pela central faz os pedidos andarem sozinhos pelas etapas,
-- mostra no link do cliente um vídeo de exemplo em cada etapa e põe uma foto final ao concluir.
-- Usado só em lojas de demonstração (ex.: petteste). Nunca ligar numa loja real.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS demo_mode boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS demo_step_seconds integer NOT NULL DEFAULT 40;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_demo_step_seconds_check') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_demo_step_seconds_check CHECK (demo_step_seconds BETWEEN 10 AND 600);
  END IF;
END $$;
