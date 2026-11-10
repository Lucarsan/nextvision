// Painel "Animais" e prontuário do pet (dono e operador da loja).
// - GET  /api/pets                 todos os animais com tutor e próximo retorno
// - GET  /api/pets/:id             ficha completa: pet, tutor e registros
// - POST /api/pets/:id/records     vacina, vermífugo, antipulgas, procedimento, consulta, exame ou anotação
// - PATCH/DELETE /api/pet-records/:id
// - GET  /api/pet-records/due      retornos/doses vencidos ou nos próximos N dias (para avisar o tutor)
import { z } from 'zod';
import { PET_FIELDS } from './customer-pets.js';

export const RECORD_KINDS = ['vaccine', 'deworming', 'antiparasitic', 'procedure', 'consult', 'exam', 'note'];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const recordBody = z.object({
  kind: z.enum(RECORD_KINDS), title: z.string().trim().min(1).max(120), record_date: day,
  next_date: z.union([day, z.literal(''), z.null()]).optional().transform(v => v || null),
  notes: z.string().trim().max(2000).optional().transform(v => v || null),
  done_next: z.boolean().optional()
}).strict();
const REC = 'r.id,r.pet_id,r.kind,r.title,r.record_date,r.next_date,r.notes,r.done_next,r.created_at';
const prefixed = PET_FIELDS.split(',').map(f => 'p.' + f).join(',');

export function registerPetRecords(app, { q, auth, roles, route, bad, valid, audit, uuid, tid }) {
  const staff = [auth, roles('owner', 'operator')];
  app.get('/api/pets', ...staff, route(async (req, res) => {
    const r = await q(`SELECT ${prefixed},c.name customer_name,c.phone customer_phone,
      (SELECT min(x.next_date) FROM pet_records x WHERE x.pet_id=p.id AND x.tenant_id=p.tenant_id AND x.deleted_at IS NULL AND x.next_date IS NOT NULL AND NOT x.done_next) next_due
      FROM customer_pets p JOIN customers c ON c.id=p.customer_id AND c.tenant_id=p.tenant_id AND c.deleted_at IS NULL
      WHERE p.tenant_id=$1 AND p.deleted_at IS NULL ORDER BY lower(p.name), lower(c.name)`, [tid(req)]);
    res.json(r.rows);
  }));
  app.get('/api/pets/:id', ...staff, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Pet inválido');
    const p = (await q(`SELECT ${prefixed},c.name customer_name,c.phone customer_phone,c.email customer_email FROM customer_pets p
      JOIN customers c ON c.id=p.customer_id AND c.tenant_id=p.tenant_id WHERE p.id=$1 AND p.tenant_id=$2 AND p.deleted_at IS NULL`, [req.params.id, tid(req)])).rows[0];
    if (!p) return bad(res, 404, 'Pet não encontrado');
    const records = (await q(`SELECT ${REC} FROM pet_records r WHERE r.pet_id=$1 AND r.tenant_id=$2 AND r.deleted_at IS NULL ORDER BY r.record_date DESC, r.created_at DESC`, [p.id, tid(req)])).rows;
    // Atendimentos do pet na loja: pedidos do tutor com o nome do animal.
    const orders = (await q(`SELECT o.id,o.status,o.created_at,o.completed_at,o.process_snapshot->>'name' process,o.details->>'service' service
      FROM orders o WHERE o.tenant_id=$1 AND o.customer_id=$2 AND o.deleted_at IS NULL AND lower(o.details->>'pet_name')=lower($3)
      ORDER BY o.created_at DESC LIMIT 50`, [tid(req), p.customer_id, p.name])).rows;
    res.json({ ...p, records, orders });
  }));
  app.post('/api/pets/:id/records', ...staff, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Pet inválido');
    const v = valid(recordBody, req, res); if (!v) return;
    if (v.next_date && v.next_date < v.record_date) return bad(res, 400, 'O retorno não pode ser antes da data do registro');
    const r = await q(`INSERT INTO pet_records(tenant_id,pet_id,kind,title,record_date,next_date,notes,done_next,created_by)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9 WHERE EXISTS(SELECT 1 FROM customer_pets WHERE id=$2 AND tenant_id=$1 AND deleted_at IS NULL)
      RETURNING ${REC.replace(/r\./g, '')}`, [tid(req), req.params.id, v.kind, v.title, v.record_date, v.next_date, v.notes, v.done_next ?? false, req.user.id]);
    if (!r.rowCount) return bad(res, 404, 'Pet não encontrado');
    // Registrar uma dose nova dá baixa no retorno pendente do mesmo item (ex.: V10 reforço).
    await q(`UPDATE pet_records SET done_next=true WHERE tenant_id=$1 AND pet_id=$2 AND id<>$3 AND deleted_at IS NULL AND NOT done_next
      AND kind=$4 AND lower(title)=lower($5) AND next_date IS NOT NULL AND record_date<=$6`, [tid(req), req.params.id, r.rows[0].id, v.kind, v.title, v.record_date]);
    await audit(req, 'create', 'pet_record', r.rows[0].id); res.status(201).json(r.rows[0]);
  }));
  app.patch('/api/pet-records/:id', ...staff, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Registro inválido');
    const v = valid(recordBody, req, res); if (!v) return;
    if (v.next_date && v.next_date < v.record_date) return bad(res, 400, 'O retorno não pode ser antes da data do registro');
    const r = await q(`UPDATE pet_records SET kind=$3,title=$4,record_date=$5,next_date=$6,notes=$7,done_next=$8 WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL
      RETURNING ${REC.replace(/r\./g, '')}`, [req.params.id, tid(req), v.kind, v.title, v.record_date, v.next_date, v.notes, v.done_next ?? false]);
    if (!r.rowCount) return bad(res, 404, 'Registro não encontrado');
    await audit(req, 'update', 'pet_record', req.params.id); res.json(r.rows[0]);
  }));
  app.delete('/api/pet-records/:id', ...staff, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'Registro inválido');
    const r = await q('UPDATE pet_records SET deleted_at=now() WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL RETURNING id', [req.params.id, tid(req)]);
    if (!r.rowCount) return bad(res, 404, 'Registro não encontrado');
    await audit(req, 'delete', 'pet_record', req.params.id); res.status(204).end();
  }));
  app.get('/api/pet-records/due', ...staff, route(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const r = await q(`SELECT ${REC},p.name pet_name,p.species,c.id customer_id,c.name customer_name,c.phone customer_phone
      FROM pet_records r JOIN customer_pets p ON p.id=r.pet_id AND p.tenant_id=r.tenant_id AND p.deleted_at IS NULL
      JOIN customers c ON c.id=p.customer_id AND c.tenant_id=p.tenant_id AND c.deleted_at IS NULL
      WHERE r.tenant_id=$1 AND r.deleted_at IS NULL AND NOT r.done_next AND r.next_date IS NOT NULL
        AND r.next_date <= (now() AT TIME ZONE 'America/Sao_Paulo')::date + $2::int
      ORDER BY r.next_date, lower(p.name)`, [tid(req), days]);
    res.json(r.rows);
  }));
}
