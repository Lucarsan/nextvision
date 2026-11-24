// Cadastro único de clientes nas lojas de uma rede (ex.: Audace Joias, 7 quiosques).
// Cada loja continua com a sua ficha (o resto do sistema não muda); fichas da mesma pessoa
// em lojas da mesma rede ficam ligadas por customers.link_id. Achar a cliente em outra unidade
// cria a ficha local ligada ("adotar"), e o cashback soma os lotes de todas as fichas ligadas.

// Fichas ligadas a cada cliente (inclui a própria), só dentro da rede da loja.
export async function linkedIds(client, tenantId, ids) {
  const out = new Map(ids.map(id => [id, [id]]));
  if (!ids.length) return out;
  const r = await client.query(`SELECT c.id, array_agg(o.id) ids FROM customers c
      JOIN tenants t ON t.id=c.tenant_id AND t.network_id IS NOT NULL
      JOIN customers o ON o.link_id=c.link_id AND o.deleted_at IS NULL
      JOIN tenants ot ON ot.id=o.tenant_id AND ot.network_id=t.network_id
    WHERE c.tenant_id=$1 AND c.id=ANY($2::uuid[]) AND c.link_id IS NOT NULL GROUP BY c.id`, [tenantId, ids]);
  for (const x of r.rows) out.set(x.id, [...new Set([x.id, ...x.ids])]);
  return out;
}

// Liga a ficha local a fichas da mesma pessoa em outras unidades da rede (mesmo CPF ou telefone).
export async function linkLocal(client, tenantId, customerId) {
  const c = (await client.query(`SELECT c.id,c.cpf,c.phone_key,c.link_id,t.network_id FROM customers c JOIN tenants t ON t.id=c.tenant_id WHERE c.id=$1 AND c.tenant_id=$2`, [customerId, tenantId])).rows[0];
  if (!c?.network_id || (!c.cpf && !c.phone_key)) return;
  const other = (await client.query(`SELECT o.id,o.link_id FROM customers o JOIN tenants t ON t.id=o.tenant_id
      WHERE t.network_id=$1 AND o.tenant_id<>$2 AND o.deleted_at IS NULL AND (($3::text IS NOT NULL AND o.cpf=$3) OR ($4::text IS NOT NULL AND o.phone_key=$4))
      ORDER BY (o.link_id IS NOT NULL) DESC, o.created_at LIMIT 1`, [c.network_id, tenantId, c.cpf, c.phone_key])).rows[0];
  if (!other) return;
  const link = other.link_id || c.link_id || other.id;
  await client.query('UPDATE customers SET link_id=$1 WHERE id=ANY($2::uuid[]) AND link_id IS DISTINCT FROM $1', [link, [c.id, other.id]]);
}

// Clientes de outras unidades da rede (pelo nome, CPF ou telefone) que ainda não têm ficha nesta loja.
export async function searchNetwork(client, tenantId, term, digits, limit = 8) {
  const t = (await client.query('SELECT network_id FROM tenants WHERE id=$1', [tenantId])).rows[0];
  if (!t?.network_id) return [];
  const r = await client.query(`SELECT DISTINCT ON (coalesce(o.link_id,o.id)) o.id,o.name,o.phone,o.offers_opt_out,coalesce(ut.unit_label,ut.name) unit
      FROM customers o JOIN tenants ut ON ut.id=o.tenant_id
      WHERE ut.network_id=$1 AND o.tenant_id<>$2 AND o.deleted_at IS NULL
        AND (fp_fold(o.name) LIKE '%'||fp_fold($3)||'%' OR (length($4)=11 AND o.cpf=$4) OR (length($4)>=8 AND regexp_replace(coalesce(o.phone,''),'\\D','','g') LIKE '%'||$4||'%'))
        AND NOT EXISTS (SELECT 1 FROM customers l WHERE l.tenant_id=$2 AND l.deleted_at IS NULL AND o.link_id IS NOT NULL AND l.link_id=o.link_id)
      ORDER BY coalesce(o.link_id,o.id), o.created_at LIMIT $5`, [t.network_id, tenantId, term, digits, limit]);
  return r.rows;
}

// Traz para esta loja a cliente de outra unidade da rede: devolve a ficha local (cria ligada, se não existir).
export async function adopt(client, tenantId, remoteId) {
  const src = (await client.query(`SELECT o.*, t.network_id FROM customers o JOIN tenants t ON t.id=o.tenant_id
      JOIN tenants me ON me.id=$2 AND me.network_id=t.network_id WHERE o.id=$1 AND o.deleted_at IS NULL`, [remoteId, tenantId])).rows[0];
  if (!src) return null;
  if (src.tenant_id === tenantId) return src.id;
  const link = src.link_id || src.id;
  if (!src.link_id) await client.query('UPDATE customers SET link_id=$1 WHERE id=$1', [src.id]);
  const mine = (await client.query('SELECT id FROM customers WHERE tenant_id=$1 AND link_id=$2 AND deleted_at IS NULL LIMIT 1', [tenantId, link])).rows[0];
  if (mine) return mine.id;
  return (await client.query(`INSERT INTO customers(tenant_id,name,phone,email,cpf,birth_date,offers_opt_out,source,link_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,'rede',$8) RETURNING id`, [tenantId, src.name, src.phone, src.email, src.cpf, src.birth_date, src.offers_opt_out, link])).rows[0].id;
}
