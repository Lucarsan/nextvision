// Importação da carteira de outro sistema (ex.: planilhas "clientes" e "animais" de pet shop).
// O navegador lê os arquivos (public/legacy-import.js) e envia em lotes; aqui só validamos e gravamos.
// Idempotente: customers.external_id / customer_pets.external_id guardam o código do sistema antigo,
// então reenviar o mesmo lote não duplica nada.
import { z } from 'zod';

const t = n => z.string().trim().max(n).nullable().optional().transform(v => v || null);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().transform(v => v || null);
const customer = z.object({
  ext: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(120), phone: t(30),
  email: z.string().trim().email().max(200).nullable().optional().catch(null).transform(v => v || null),
  cpf: z.string().regex(/^\d{11}$/).nullable().optional().catch(null), birth: date.catch(null), address: t(500),
  cep: z.string().regex(/^\d{8}$/).nullable().optional().catch(null),
  created: z.string().regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/).nullable().optional().catch(null)
}).strict();
const pet = z.object({
  ext: z.string().trim().min(1).max(40), cust: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(80),
  species: t(40), breed: t(80), sex: z.enum(['M', 'F']).nullable().optional().catch(null), birth: date.catch(null), color: t(60),
  weight: z.number().positive().max(999).nullable().optional().catch(null), size: t(20), coat: t(20), temperament: t(40),
  neutered: z.boolean().nullable().optional(), notes: t(2000)
}).strict();
const body = z.object({ customers: z.array(customer).max(500).default([]), pets: z.array(pet).max(500).default([]) }).strict();

export function registerLegacyImport(app, { q, auth, roles, route, valid, audit, tid }) {
  app.post('/api/customers/import-legacy', auth, roles('owner'), route(async (req, res) => {
    const v = valid(body, req, res); if (!v) return;
    const tenant = tid(req); let customers = 0, pets = 0, orphanPets = 0;
    if (v.customers.length) {
      const r = await q(`INSERT INTO customers(tenant_id,name,phone,email,cpf,birth_date,address,postal_code,source,external_id,created_at)
        SELECT $1,x->>'name',x->>'phone',x->>'email',x->>'cpf',(x->>'birth')::date,x->>'address',x->>'cep','importado',x->>'ext',
          COALESCE((x->>'created')::timestamp AT TIME ZONE 'America/Fortaleza',now())
        FROM jsonb_array_elements($2::jsonb) x
        WHERE NOT EXISTS(SELECT 1 FROM customers k WHERE k.tenant_id=$1 AND k.external_id=x->>'ext')
        ON CONFLICT DO NOTHING`, [tenant, JSON.stringify(v.customers)]);
      customers = r.rowCount;
    }
    if (v.pets.length) {
      const r = await q(`INSERT INTO customer_pets(tenant_id,customer_id,name,species,breed,sex,birth_date,color,weight_kg,size,coat,temperament,neutered,notes,external_id)
        SELECT $1,k.id,x->>'name',x->>'species',x->>'breed',x->>'sex',(x->>'birth')::date,x->>'color',(x->>'weight')::numeric,x->>'size',x->>'coat',
          x->>'temperament',(x->>'neutered')::boolean,x->>'notes',x->>'ext'
        FROM jsonb_array_elements($2::jsonb) x
        JOIN customers k ON k.tenant_id=$1 AND k.external_id=x->>'cust' AND k.deleted_at IS NULL
        WHERE NOT EXISTS(SELECT 1 FROM customer_pets p WHERE p.tenant_id=$1 AND p.external_id=x->>'ext')
        ON CONFLICT DO NOTHING`, [tenant, JSON.stringify(v.pets)]);
      pets = r.rowCount;
      const known = await q(`SELECT count(*)::int n FROM jsonb_array_elements($2::jsonb) x
        WHERE NOT EXISTS(SELECT 1 FROM customers k WHERE k.tenant_id=$1 AND k.external_id=x->>'cust' AND k.deleted_at IS NULL)`, [tenant, JSON.stringify(v.pets)]);
      orphanPets = known.rows[0].n;
    }
    await audit(req, 'import_legacy', 'customer', `${customers} clientes, ${pets} pets`);
    res.json({ customers, pets, orphan_pets: orphanPets });
  }));
}
