// Ficha dos animais de cada tutor (pet shop / veterinária).
// - GET/POST /api/customers/:id/pets, PATCH/DELETE /api/pets/:id (dono e operador da loja).
// - Ao criar um pedido de pet com nome do animal, a ficha é criada se o tutor ainda não tem
//   um pet com esse nome (savePetFromOrder).
import { z } from 'zod';

const SIZES = ['Mini', 'Pequeno', 'Médio', 'Grande', 'Gigante'];
const text = n => z.string().trim().max(n).optional().transform(v => v || null);
const petBody = z.object({
  name: z.string().trim().min(1).max(80),
  species: text(40), breed: text(80), color: text(60), size: text(20), coat: text(20), temperament: text(40), notes: text(2000),
  sex: z.union([z.enum(['M', 'F']), z.literal('')]).optional().transform(v => v || null),
  birth_date: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal('')]).optional().transform(v => v || null),
  weight_kg: z.union([z.number().positive().max(999), z.null()]).optional(),
  neutered: z.union([z.boolean(), z.null()]).optional(),
  customer_id: z.string().uuid().optional()
}).strict();
export const PET_FIELDS = 'id,customer_id,name,species,breed,sex,birth_date,color,weight_kg,size,coat,temperament,neutered,notes,created_at';

export async function savePetFromOrder(q, tenantId, customerId, d) {
  const name = String(d?.pet_name || '').trim().slice(0, 80);
  if (!name || d.item_type !== 'pet') return;
  const size = SIZES.includes(d.size) ? d.size : (String(d.size || '').trim().slice(0, 20) || null);
  await q(`INSERT INTO customer_pets(tenant_id,customer_id,name,species,breed,size)
    SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS(SELECT 1 FROM customers WHERE id=$2 AND tenant_id=$1 AND deleted_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM customer_pets WHERE tenant_id=$1 AND customer_id=$2 AND deleted_at IS NULL AND lower(name)=lower($3))`,
  [tenantId, customerId, name, String(d.species || '').trim().slice(0, 40) || null, String(d.breed || '').trim().slice(0, 80) || null, size]);
}

export function registerCustomerPets(app, { q, auth, roles, route, bad, valid, audit, uuid, tid }) {
  const staff = [auth, roles('owner', 'operator')];
  app.get('/api/customers/:id/pets', ...staff, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Cliente inválido');
    const r = await q(`SELECT ${PET_FIELDS} FROM customer_pets WHERE tenant_id=$1 AND customer_id=$2 AND deleted_at IS NULL ORDER BY lower(name)`, [tid(req), req.params.id]);
    res.json(r.rows);
  }));
  app.post('/api/customers/:id/pets', ...staff, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Cliente inválido');
    const v = valid(petBody, req, res); if (!v) return;
    if (v.customer_id && v.customer_id !== req.params.id) return bad(res, 400, 'Tutor inválido');
    const r = await q(`INSERT INTO customer_pets(tenant_id,customer_id,name,species,breed,sex,birth_date,color,weight_kg,size,coat,temperament,neutered,notes)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14 WHERE EXISTS(SELECT 1 FROM customers WHERE id=$2 AND tenant_id=$1 AND deleted_at IS NULL)
      RETURNING ${PET_FIELDS}`, [tid(req), req.params.id, v.name, v.species, v.breed, v.sex, v.birth_date, v.color, v.weight_kg ?? null, v.size, v.coat, v.temperament, v.neutered ?? null, v.notes]);
    if (!r.rowCount) return bad(res, 404, 'Cliente não encontrado');
    await audit(req, 'create', 'pet', r.rows[0].id); res.status(201).json(r.rows[0]);
  }));
  app.patch('/api/pets/:id', ...staff, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Pet inválido');
    const v = valid(petBody, req, res); if (!v) return;
    // customer_id (opcional) troca o tutor, desde que seja cliente desta loja.
    if (v.customer_id && !(await q('SELECT 1 FROM customers WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [v.customer_id, tid(req)])).rowCount) return bad(res, 400, 'Tutor não encontrado');
    const r = await q(`UPDATE customer_pets SET name=$3,species=$4,breed=$5,sex=$6,birth_date=$7,color=$8,weight_kg=$9,size=$10,coat=$11,temperament=$12,neutered=$13,notes=$14,customer_id=COALESCE($15::uuid,customer_id),updated_at=now()
      WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL RETURNING ${PET_FIELDS}`,
    [req.params.id, tid(req), v.name, v.species, v.breed, v.sex, v.birth_date, v.color, v.weight_kg ?? null, v.size, v.coat, v.temperament, v.neutered ?? null, v.notes, v.customer_id || null]);
    if (!r.rowCount) return bad(res, 404, 'Pet não encontrado');
    await audit(req, 'update', 'pet', req.params.id); res.json(r.rows[0]);
  }));
  app.delete('/api/pets/:id', ...staff, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Pet inválido');
    const r = await q('UPDATE customer_pets SET deleted_at=now() WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL RETURNING id', [req.params.id, tid(req)]);
    if (!r.rowCount) return bad(res, 404, 'Pet não encontrado');
    await audit(req, 'delete', 'pet', req.params.id); res.status(204).end();
  }));
}
