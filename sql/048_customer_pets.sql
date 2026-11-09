-- Ficha dos animais de cada tutor (pet shop / veterinária). O pedido continua guardando o
-- nome/raça/porte em orders.details; a ficha serve para buscar o tutor pelo nome do pet e
-- preencher o pedido. external_id guarda o código do sistema antigo (importação idempotente).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS external_id text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_external ON customers(tenant_id, external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS customer_pets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  species text CHECK (species IS NULL OR length(species) <= 40),
  breed text CHECK (breed IS NULL OR length(breed) <= 80),
  sex text CHECK (sex IS NULL OR sex IN ('M','F')),
  birth_date date,
  color text CHECK (color IS NULL OR length(color) <= 60),
  weight_kg numeric(6,2) CHECK (weight_kg IS NULL OR weight_kg > 0),
  size text CHECK (size IS NULL OR length(size) <= 20),
  coat text CHECK (coat IS NULL OR length(coat) <= 20),
  temperament text CHECK (temperament IS NULL OR length(temperament) <= 40),
  neutered boolean,
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_customer_pets_customer ON customer_pets(tenant_id, customer_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_pets_external ON customer_pets(tenant_id, external_id) WHERE external_id IS NOT NULL;
