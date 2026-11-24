// Relatórios da rede: resumo do dia anterior por e-mail (às 8h, para os e-mails da rede) e faturamento do mês
// por unidade, dia a dia, para o shopping (CSV no painel da rede).
import { z } from 'zod';
import { sendEmail, emailConfigured } from './reports.js';
import { backgroundAllowed } from './quiet-hours.js';

const TZ = 'America/Fortaleza';
const brl = c => 'R$ ' + (Number(c || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const METHODS = { cash: 'Dinheiro', pix: 'Pix', debit: 'Débito', credit: 'Crédito' };

// Vendas por unidade num intervalo de dias (inclusive), sem as canceladas; pagamento dividido entra por forma.
export async function unitTotals(q, networkId, from, to) {
  return (await q(`WITH u AS (SELECT id, coalesce(unit_label, name) unit, cnpj FROM tenants WHERE network_id = $1 AND NOT depot),
      s AS (SELECT x.* FROM sales x JOIN u ON u.id = x.tenant_id WHERE (x.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date),
      p AS (SELECT s.tenant_id, coalesce(e.method, s.payment_method) method, coalesce(e.amount, s.total_cents) amount FROM s
            LEFT JOIN LATERAL (SELECT j->>'method' method, (j->>'amount_cents')::int amount FROM jsonb_array_elements(CASE WHEN s.payment_method = 'mixed' THEN s.payments ELSE '[]'::jsonb END) j) e ON true
            WHERE s.canceled_at IS NULL)
    SELECT u.id, u.unit, u.cnpj,
      (SELECT count(*) FROM s WHERE s.tenant_id = u.id AND s.canceled_at IS NULL)::int sales,
      (SELECT coalesce(sum(total_cents), 0) FROM s WHERE s.tenant_id = u.id AND s.canceled_at IS NULL)::bigint total,
      (SELECT count(*) FROM s WHERE s.tenant_id = u.id AND s.canceled_at IS NOT NULL)::int canceled,
      (SELECT coalesce(jsonb_object_agg(method, amt), '{}') FROM (SELECT method, sum(amount) amt FROM p WHERE p.tenant_id = u.id GROUP BY method) m) by_method,
      (SELECT coalesce(sum(counted_cash_cents - expected_cash_cents), 0) FROM cash_sessions c WHERE c.tenant_id = u.id AND c.status = 'closed' AND (c.closed_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date)::bigint cash_diff
    FROM u ORDER BY u.unit`, [networkId, from, to, TZ])).rows;
}

function dailyHtml(net, day, rows, sellers) {
  const total = rows.reduce((a, r) => a + Number(r.total), 0), n = rows.reduce((a, r) => a + r.sales, 0);
  const td = 'style="padding:6px 8px;border-bottom:1px solid #eee"', tdr = 'style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right"';
  return `<div style="font-family:Arial,sans-serif;color:#222;max-width:720px">
<h2 style="margin:0 0 4px">${esc(net.name)} · resumo de ${esc(day.split('-').reverse().join('/'))}</h2>
<p style="margin:0 0 14px;color:#666">${n} vendas · faturamento ${brl(total)} · ticket médio ${brl(n ? Math.round(total / n) : 0)}</p>
<table style="border-collapse:collapse;width:100%;font-size:14px"><tr style="background:#f4f2ec"><th align="left" ${td}>Unidade</th><th ${tdr}>Vendas</th><th ${tdr}>Faturamento</th>${Object.values(METHODS).map(m => `<th ${tdr}>${m}</th>`).join('')}<th ${tdr}>Cancel.</th><th ${tdr}>Dif. caixa</th></tr>
${rows.map(r => `<tr><td ${td}>${esc(r.unit)}</td><td ${tdr}>${r.sales}</td><td ${tdr}><b>${brl(r.total)}</b></td>${Object.keys(METHODS).map(k => `<td ${tdr}>${brl(r.by_method?.[k] || 0)}</td>`).join('')}<td ${tdr}>${r.canceled || ''}</td><td ${tdr}${Number(r.cash_diff) ? ' style="color:#b42318"' : ''}>${Number(r.cash_diff) ? brl(r.cash_diff) : ''}</td></tr>`).join('')}
</table>
${sellers.length ? `<h3 style="margin:18px 0 6px">Vendedoras do dia</h3><table style="border-collapse:collapse;font-size:14px">${sellers.map(s => `<tr><td ${td}>${esc(s.name)}</td><td ${td}>${esc(s.unit)}</td><td ${tdr}>${s.n}</td><td ${tdr}>${brl(s.total)}</td></tr>`).join('')}</table>` : ''}
<p style="color:#999;font-size:12px;margin-top:18px">Enviado pelo FicouPronto. Detalhes no painel da rede.</p></div>`;
}

export async function runNetworkReports(q, now = new Date()) {
  const local = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
  if (local.getHours() < 8) return [];
  const y = new Date(local); y.setDate(y.getDate() - 1);
  const day = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  const nets = (await q("SELECT id, name, report_emails FROM store_networks WHERE status = 'active' AND cardinality(report_emails) > 0")).rows;
  const out = [];
  for (const net of nets) {
    // Sem movimento no dia (nenhuma venda, cancelamento ou caixa): não manda e-mail vazio.
    const moved = await q(`SELECT 1 FROM tenants t WHERE t.network_id = $1 AND (
        EXISTS (SELECT 1 FROM sales x WHERE x.tenant_id = t.id AND (x.created_at AT TIME ZONE $3)::date = $2::date)
        OR EXISTS (SELECT 1 FROM cash_sessions c WHERE c.tenant_id = t.id AND ((c.opened_at AT TIME ZONE $3)::date = $2::date OR (c.closed_at AT TIME ZONE $3)::date = $2::date))) LIMIT 1`, [net.id, day, TZ]);
    if (!moved.rowCount) { out.push({ network: net.id, day, skipped: true }); continue; }
    const claim = await q(`INSERT INTO network_report_runs(network_id, period_key) VALUES($1, $2)
      ON CONFLICT (network_id, period_key) DO UPDATE SET status = 'sending', attempts = network_report_runs.attempts + 1, updated_at = now()
        WHERE network_report_runs.status = 'error' AND network_report_runs.attempts < 3 AND network_report_runs.updated_at < now() - interval '10 minutes'
      RETURNING attempts`, [net.id, day]);
    if (!claim.rowCount) continue;
    try {
      const rows = await unitTotals(q, net.id, day, day);
      const sellers = (await q(`SELECT u.name, coalesce(t.unit_label, t.name) unit, count(*)::int n, sum(x.total_cents)::bigint total FROM sales x JOIN users u ON u.id = x.seller_id JOIN tenants t ON t.id = x.tenant_id
        WHERE t.network_id = $1 AND x.canceled_at IS NULL AND (x.created_at AT TIME ZONE $3)::date = $2::date GROUP BY 1, 2 ORDER BY 4 DESC`, [net.id, day, TZ])).rows;
      for (const to of net.report_emails) await sendEmail(to, `${net.name}: resumo de ${day.split('-').reverse().join('/')}`, dailyHtml(net, day, rows, sellers));
      await q("UPDATE network_report_runs SET status = 'sent', error = NULL, updated_at = now() WHERE network_id = $1 AND period_key = $2", [net.id, day]);
      out.push({ network: net.id, day, ok: true });
    } catch (e) {
      await q("UPDATE network_report_runs SET status = 'error', error = $3, updated_at = now() WHERE network_id = $1 AND period_key = $2", [net.id, day, String(e.message).slice(0, 300)]);
      out.push({ network: net.id, day, ok: false });
    }
  }
  return out;
}

export function registerNetworkReports(app, { q, auth, roles, route, bad, valid, audit, uuid }) {
  const network = [auth, roles('network')];
  // Faturamento do mês por unidade e por dia (relatório para o shopping).
  app.get('/api/network/report/month', ...network, route(async (req, res) => {
    const m = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).safeParse(req.query);
    if (!m.success) return bad(res, 400, 'Mês inválido');
    const scope = req.user.network_access === 'supervisor' ? (req.user.network_unit_ids || []) : null;
    const r = await q(`SELECT coalesce(t.unit_label, t.name) unit, t.cnpj, to_char((x.created_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS day, count(*)::int sales, sum(x.total_cents)::bigint total
      FROM sales x JOIN tenants t ON t.id = x.tenant_id WHERE t.network_id = $1 AND ($4::uuid[] IS NULL OR t.id = ANY($4)) AND x.canceled_at IS NULL
        AND to_char(x.created_at AT TIME ZONE $3, 'YYYY-MM') = $2 GROUP BY 1, 2, 3 ORDER BY 1, 3`, [req.user.network_id, m.data.month, TZ, scope]);
    res.set('Cache-Control', 'no-store').json({ month: m.data.month, rows: r.rows.map(x => ({ ...x, total_cents: Number(x.total) })) });
  }));
  // Central: e-mails que recebem o resumo diário da rede.
  app.put('/api/master/networks/:id/report-emails', auth, roles('master'), route(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, 400, 'ID inválido');
    const v = valid(z.object({ emails: z.array(z.string().trim().toLowerCase().email().max(200)).max(10) }).strict(), req, res); if (!v) return;
    const r = await q('UPDATE store_networks SET report_emails = $2 WHERE id = $1 RETURNING report_emails', [req.params.id, [...new Set(v.emails)]]);
    if (!r.rowCount) return bad(res, 404, 'Rede não encontrada');
    await audit(req, 'update', 'network_report_emails', req.params.id); res.json(r.rows[0]);
  }));
  const tick = () => !backgroundAllowed() || !emailConfigured() ? null : runNetworkReports(q).catch(e => console.error('Resumo da rede', e.code || e.message));
  setTimeout(tick, 45000).unref(); setInterval(tick, 10 * 60000).unref();
}
