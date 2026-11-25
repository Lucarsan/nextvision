-- Emissor ACBr API (NFC-e): endereço do emitente, numeração própria da homologação e cupons de teste.
-- Endereço estruturado do emitente (enderEmit): {street, number, complement, district, city_code, city, cep}.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS fiscal_address jsonb;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS fiscal_email text CHECK (fiscal_email IS NULL OR length(fiscal_email) BETWEEN 5 AND 120);
-- Homologação tem numeração separada da produção (nfce_next_number fica intocado pelos testes).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS nfce_hom_next_number integer NOT NULL DEFAULT 1 CHECK (nfce_hom_next_number BETWEEN 1 AND 999999999);
-- Cupom de teste (homologação) não tem venda.
ALTER TABLE fiscal_documents ALTER COLUMN sale_id DROP NOT NULL;
ALTER TABLE fiscal_documents ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
ALTER TABLE fiscal_documents ADD COLUMN IF NOT EXISTS response jsonb;
-- Grand Shopping (GRK Joias): endereço do cadastro público do CNPJ, conferido em 24/11/2026.
UPDATE tenants SET fiscal_address = '{"street":"Av. Frei Cirilo","number":"3840","complement":null,"district":"Messejana","city_code":"2304400","city":"Fortaleza","cep":"60840285"}'::jsonb,
  legal_name = coalesce(legal_name, 'GRK JOIAS E ACESSORIOS LTDA')
  WHERE cnpj = '46383376000123' AND fiscal_address IS NULL;
