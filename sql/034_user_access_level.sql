-- Nível do operador: 'full' (livre, pode tudo no painel da loja) ou 'basic' (novato: vende, faz pedidos e
-- cadastra produtos; não dá desconto, não muda preço, não cancela venda, não lança saídas e não fecha o caixa).
-- Dono é sempre 'full'. Operadores já existentes ficam como livres.
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_level text NOT NULL DEFAULT 'full';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_access_level_check;
ALTER TABLE users ADD CONSTRAINT users_access_level_check CHECK (access_level IN ('full', 'basic'));
