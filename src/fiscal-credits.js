// Créditos do emissor de NFC-e por rede: pacotes comprados x operações usadas, com aviso por e-mail
// ao chegar em 85% e em 100%. A emissão registra cada operação em fiscal_operations (recordOperation).
import { z } from 'zod';
import { sendEmail, emailConfigured } from './reports.js';
import { backgroundAllowed } from './quiet-hours.js';

export const THRESHOLDS = [85, 100];
const TZ = 'America/Fortaleza';

export async function recordOperation(q, { networkId, tenantId = null, kind, quantity = 1, documentId = null, note = null }) {
  if (!networkId) return null;
  return (await q('INSERT INTO fiscal_operations(network_id,tenant_id,kind,quantity,fiscal_document_id,note) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [networkId, tenantId, kind, quantity, documentId, note])).rows[0];
}

export async function creditStatus(q, networkId) {
  const [pk, used, month, units] = await Promise.all([
    q('SELECT id,provider,operations,price_cents,to_char(purchased_on,\'YYYY-MM-DD\') purchased_on,notes FROM fiscal_credit_packages WHERE network_id=$1 ORDER BY purchased_on DESC, created_at DESC', [networkId]),
    q('SELECT coalesce(sum(quantity),0)::int n FROM fiscal_operations WHERE network_id=$1', [networkId]),
    q(`SELECT to_char(date_trunc('month', created_at AT TIME ZONE $2),'YYYY-MM') m, sum(quantity)::int n FROM fiscal_operations WHERE network_id=$1 AND created_at > now() - interval '120 days' GROUP BY 1 ORDER BY 1`, [networkId, TZ]),
    q(`SELECT coalesce(t.unit_label,t.name) unit, sum(o.quantity)::int n FROM fiscal_operations o JOIN tenants t ON t.id=o.tenant_id
        WHERE o.network_id=$1 AND (o.created_at AT TIME ZONE $2) >= date_trunc('month', now() AT TIME ZONE $2) GROUP BY 1 ORDER BY 2 DESC`, [networkId, TZ])]);
  const purchased = pk.rows.reduce((a, p) => a + p.operations, 0), usedN = used.rows[0].n, remaining = purchased - usedN;
  // Média dos últimos meses completos (ou do mês atual, se só houver ele) para prever quando acaba.
  const full = month.rows.slice(0, -1), avg = (full.length ? full : month.rows).reduce((a, m) => a + m.n, 0) / Math.max(1, (full.length ? full : month.rows).length);
  return { purchased, used: usedN, remaining, percent: purchased ? Math.round(usedN * 1000 / purchased) / 10 : 0,
    monthly_avg: Math.round(avg), months_left: avg > 0 && remaining > 0 ? Math.round(remaining / avg * 10) / 10 : null,
    packages: pk.rows, by_month: month.rows, by_unit_this_month: units.rows };
}

// Manda o aviso de 85% / 100% uma vez por total comprado.
export async function checkFiscalCredits(q) {
  const nets = (await q("SELECT n.id,n.name,n.report_emails FROM store_networks n WHERE n.status='active' AND EXISTS (SELECT 1 FROM fiscal_credit_packages p WHERE p.network_id=n.id)")).rows;
  const out = [];
  for (const n of nets) {
    const s = await creditStatus(q, n.id);
    const hit = THRESHOLDS.filter(t => s.percent >= t).pop(); if (!hit) continue;
    const claim = await q('INSERT INTO fiscal_credit_alerts(network_id,threshold,purchased_total) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING threshold', [n.id, hit, s.purchased]);
    if (!claim.rowCount) continue;
    const to = [...new Set([...(n.report_emails || []), ...(process.env.FISCAL_CREDIT_ALERT_EMAIL ? [process.env.FISCAL_CREDIT_ALERT_EMAIL] : [])])];
    const subject = hit >= 100 ? `${n.name}: créditos do emissor de NFC-e acabaram` : `${n.name}: ${hit}% dos créditos do emissor de NFC-e usados`;
    const html = `<p><b>${subject}</b></p><p>Contratado: ${s.purchased.toLocaleString('pt-BR')} operações · usado: ${s.used.toLocaleString('pt-BR')} (${s.percent.toLocaleString('pt-BR')}%) · restam ${Math.max(0, s.remaining).toLocaleString('pt-BR')}.</p>`
      + (s.months_left ? `<p>No ritmo atual (${s.monthly_avg} por mês), dá para cerca de ${s.months_left.toLocaleString('pt-BR')} mês(es).</p>` : '')
      + `<p>${hit >= 100 ? 'Sem créditos o cupom fiscal pode parar de sair. Fale com a FicouPronto para renovar o pacote.' : 'Fale com a FicouPronto para renovar o pacote antes de acabar.'}</p>`;
    try { for (const e of to) await sendEmail(e, subject, html); out.push({ network: n.id, threshold: hit, sent: to.length }); }
    catch (e) { await q('DELETE FROM fiscal_credit_alerts WHERE network_id=$1 AND threshold=$2 AND purchased_total=$3', [n.id, hit, s.purchased]); out.push({ network: n.id, threshold: hit, error: e.message }); }
  }
  return out;
}

export function registerFiscalCredits(app, { q, auth, roles, route, bad, valid, audit, uuid }) {
  const master = [auth, roles('master')];
  app.get('/api/network/fiscal-credits', auth, roles('network'), route(async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await creditStatus(q, req.user.network_id));
  }));
  app.get('/api/master/networks/:id/fiscal-credits', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    res.json(await creditStatus(q, req.params.id));
  }));
  app.post('/api/master/networks/:id/fiscal-credits/packages', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ provider: z.string().trim().min(2).max(60), operations: z.number().int().min(1).max(10000000), price_cents: z.number().int().min(0).max(100000000).default(0),
      purchased_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), notes: z.string().trim().max(300).default('') }).strict(), req, res); if (!v) return;
    const n = await q('SELECT 1 FROM store_networks WHERE id=$1', [req.params.id]); if (!n.rowCount) return bad(res, 404, 'Rede não encontrada');
    const r = await q('INSERT INTO fiscal_credit_packages(network_id,provider,operations,price_cents,purchased_on,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id', [req.params.id, v.provider, v.operations, v.price_cents, v.purchased_on, v.notes, req.user.id]);
    await audit(req, 'create', 'fiscal_credit_package', r.rows[0].id);
    res.status(201).json(await creditStatus(q, req.params.id));
  }));
  // Acerta o "usado" com o número que o painel do emissor mostra.
  app.post('/api/master/networks/:id/fiscal-credits/adjust', ...master, route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ used_total: z.number().int().min(0).max(100000000), note: z.string().trim().max(200).default('') }).strict(), req, res); if (!v) return;
    const cur = await creditStatus(q, req.params.id), diff = v.used_total - cur.used;
    if (diff) await recordOperation(q, { networkId: req.params.id, kind: 'ajuste', quantity: diff, note: v.note || 'Acerto com o painel do emissor' });
    await audit(req, 'adjust', 'fiscal_credits', req.params.id);
    res.json(await creditStatus(q, req.params.id));
  }));
  const tick = () => !backgroundAllowed() || !emailConfigured() ? null : checkFiscalCredits(q).catch(e => console.error('Créditos do emissor', e.code || e.message));
  setTimeout(tick, 60000).unref(); setInterval(tick, 30 * 60000).unref();
}
