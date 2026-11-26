-- Manual do sistema (páginas no menu Treinamento): quem abriu e quem leu até o fim cada página.
-- O conteúdo das páginas fica no código (src/manual-content.js); aqui só a leitura, por versão da página.
CREATE TABLE IF NOT EXISTS manual_reads (
  page_key text NOT NULL CHECK (page_key ~ '^[a-z0-9-]{2,60}$'),
  version integer NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_open_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz,
  PRIMARY KEY (page_key, version, user_id)
);
CREATE INDEX IF NOT EXISTS manual_reads_user ON manual_reads(user_id);
