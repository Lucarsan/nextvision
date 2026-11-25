-- TEF Stone (AutoTEF): cobrança no pinpad pelo caixa do quiosque.
-- O caixa (navegador) fala com o AutoTEF Slim instalado no PC da loja (http://127.0.0.1:8000);
-- o servidor guarda cada cobrança ANTES de ir ao pinpad, para nenhuma aprovação se perder
-- (aprovada sem venda = estorno pendente, que aparece no caixa até ser resolvido).

-- Modo por unidade: off (sem TEF, como hoje), simulator (pinpad de mentira, só para teste e
-- treino: nunca vira NFC-e), sandbox (Stone de teste) e production.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tef_mode text NOT NULL DEFAULT 'off' CHECK (tef_mode IN ('off', 'simulator', 'sandbox', 'production'));
-- Stone Code da conta da unidade (vem do credenciamento; o de sandbox é diferente do de produção).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tef_stone_code text CHECK (tef_stone_code IS NULL OR tef_stone_code ~ '^[0-9]{6,15}$');
-- Porta do pinpad no Windows (ex.: COM4). Vazio = o Slim procura.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tef_pinpad_port text CHECK (tef_pinpad_port IS NULL OR tef_pinpad_port ~ '^(COM[0-9]{1,3}|/dev/tty[A-Za-z0-9]{1,12})$');
-- Endereço do Slim visto pelo navegador do quiosque (padrão do AutoTEF: http://127.0.0.1:8000).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tef_local_url text CHECK (tef_local_url IS NULL OR tef_local_url ~ '^http://(127\.0\.0\.1|localhost):[0-9]{2,5}$');

CREATE TABLE IF NOT EXISTS tef_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sale_id uuid REFERENCES sales(id) ON DELETE SET NULL,
  mode text NOT NULL CHECK (mode IN ('simulator', 'sandbox', 'production')),
  method text NOT NULL CHECK (method IN ('credit', 'debit', 'pix')),
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
  installments integer NOT NULL DEFAULT 1 CHECK (installments BETWEEN 1 AND 24),
  -- pending: enviada ao pinpad, sem resposta ainda. unknown: a resposta se perdeu (conferir no extrato/Stone).
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'error', 'expired', 'unknown', 'reversed')),
  -- Cartão: acquirerTransactionKey (ATK / StoneID), exigido no cancelamento. Pix: transactionId da cobrança.
  provider_tx text CHECK (provider_tx IS NULL OR length(provider_tx) <= 80),
  auth_code text CHECK (auth_code IS NULL OR length(auth_code) <= 80),
  brand_name text CHECK (brand_name IS NULL OR length(brand_name) <= 60),
  brand_code text CHECK (brand_code IS NULL OR brand_code ~ '^[0-9]{2}$'),
  card_mask text CHECK (card_mask IS NULL OR length(card_mask) <= 30),
  e2e_id text CHECK (e2e_id IS NULL OR length(e2e_id) <= 60),
  merchant_document text CHECK (merchant_document IS NULL OR length(merchant_document) <= 20),
  stone_code text CHECK (stone_code IS NULL OR length(stone_code) <= 20),
  terminal_serial text CHECK (terminal_serial IS NULL OR length(terminal_serial) <= 40),
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 20),
  message text CHECK (message IS NULL OR length(message) <= 300),
  client_receipt text CHECK (client_receipt IS NULL OR length(client_receipt) <= 8000),
  merchant_receipt text CHECK (merchant_receipt IS NULL OR length(merchant_receipt) <= 8000),
  -- Resposta do Slim como veio (sem os comprovantes, que ficam nas colunas acima).
  response jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  reversed_at timestamptz,
  reversed_by uuid REFERENCES users(id),
  resolved_note text CHECK (resolved_note IS NULL OR length(resolved_note) <= 300)
);
CREATE INDEX IF NOT EXISTS idx_tef_tx_tenant_created ON tef_transactions(tenant_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tef_tx_sale ON tef_transactions(sale_id, method) WHERE sale_id IS NOT NULL;
-- Pendências do caixa: aprovadas sem venda (ou de venda cancelada) e as sem resposta.
CREATE INDEX IF NOT EXISTS idx_tef_tx_open ON tef_transactions(tenant_id) WHERE status IN ('approved', 'pending', 'unknown') AND resolved_note IS NULL;
