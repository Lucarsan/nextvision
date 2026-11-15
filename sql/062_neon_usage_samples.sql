-- Uma leitura por dia do consumo do banco (para prever pelo ritmo recente, não pela média do mês).
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS neon_usage_samples jsonb NOT NULL DEFAULT '[]'::jsonb;
