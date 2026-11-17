-- Reposição de peças pelos serviços feitos: serviço que não teve a peça escolhida na hora (ex.: feito antes de a
-- peça estar cadastrada) pode ser ligado depois à peça que usou. Isso põe a peça na reposição sem mexer no estoque
-- (a quantidade já foi contada). part_none = a pessoa disse que esse serviço não usou peça do estoque.
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS restock_part_id uuid REFERENCES products(id);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS part_none boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_sale_items_restock_part ON sale_items(restock_part_id) WHERE restock_part_id IS NOT NULL;
