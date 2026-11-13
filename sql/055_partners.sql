-- Lojas parceiras na página pública /lojas (mapa e lista por nicho).
-- Só aparecem lojas marcadas pela central (partner_listed), ativas ou em teste, fora do modo demonstração.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS partner_listed boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS partner_description text CHECK (partner_description IS NULL OR length(partner_description) <= 400);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS partner_lat double precision CHECK (partner_lat IS NULL OR partner_lat BETWEEN -90 AND 90);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS partner_lng double precision CHECK (partner_lng IS NULL OR partner_lng BETWEEN -180 AND 180);

-- Primeiras parceiras (pedido do Lucas em 12/11/2026). Sem efeito onde essas lojas não existem.
UPDATE tenants SET partner_listed = true,
  partner_description = COALESCE(partner_description, 'Pet shop e centro veterinário em Messejana. O tutor acompanha o banho e a tosa do pet pelo celular.'),
  partner_lat = COALESCE(partner_lat, -3.8385410), partner_lng = COALESCE(partner_lng, -38.5012584)
WHERE slug = 'alepets';
UPDATE tenants SET partner_listed = true,
  partner_description = COALESCE(partner_description, 'Assistência técnica em Fortaleza. O cliente acompanha o reparo do aparelho pelo celular.')
WHERE slug = 'elitech';
