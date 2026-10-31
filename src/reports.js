// Relatórios da loja por e-mail (Resend): diário às 18h, semanal no sábado às 15h e mensal no último
// dia do mês às 18h, no fuso da loja. Cada envio é registrado em report_runs para não duplicar.
// O agendador roda dentro do servidor (a cada 5 min) e também por um ping externo
// (POST /api/internal/reports/run com x-cron-key), que acorda o Render no horário.
import crypto from 'node:crypto';
import { z } from 'zod';

const TZ = process.env.STORE_TIMEZONE || 'America/Fortaleza';
const SCHEDULE = { daily: { hour: 18 }, weekly: { hour: 15, weekday: 6 }, monthly: { hour: 18 } };
const KIND_LABEL = { daily: 'diário', weekly: 'semanal', monthly: 'mensal' };
const METHODS = { cash: 'Dinheiro', pix: 'Pix', debit: 'Débito', credit: 'Crédito', other: 'Outro' };
const MOVE = { withdrawal: 'Sangria', deposit: 'Suprimento' };

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = c => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const dmy = s => s.split('-').reverse().join('/');

// Data e hora "de parede" no fuso da loja, representadas num Date em UTC (só para contas de calendário).
export function localNow(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map(x => [x.type, x.value]));
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute));
}
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const lastDayOfMonth = d => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();

// Período de cada relatório (datas locais, fim exclusivo) e a chave que evita envio duplicado.
export function periodFor(kind, day) {
  const d = new Date(day + 'T00:00:00Z');
  if (kind === 'daily') return { from: day, to: ymd(addDays(d, 1)), key: day, title: dmy(day) };
  if (kind === 'weekly') { const from = ymd(addDays(d, -6)); return { from, to: ymd(addDays(d, 1)), key: day, title: `${dmy(from)} a ${dmy(day)}` }; }
  const from = `${day.slice(0, 7)}-01`, end = ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
  return { from, to: end, key: day.slice(0, 7), title: new Date(from + 'T12:00:00Z').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
}
// Quais relatórios já deveriam ter saído hoje (a partir do horário, até o fim do dia).
export function dueKinds(now = new Date()) {
  const l = localNow(now), hour = l.getUTCHours(), day = ymd(l), out = [];
  if (hour >= SCHEDULE.daily.hour) out.push({ kind: 'daily', day });
  if (l.getUTCDay() === SCHEDULE.weekly.weekday && hour >= SCHEDULE.weekly.hour) out.push({ kind: 'weekly', day });
  if (l.getUTCDate() === lastDayOfMonth(l) && hour >= SCHEDULE.monthly.hour) out.push({ kind: 'monthly', day });
  return out;
}

export async function reportData(q, tenantId, kind, day) {
  const per = periodFor(kind, day);
  const range = [tenantId, per.from, per.to, TZ];
  const inRange = col => `${col} >= ($2::date::timestamp AT TIME ZONE $4) AND ${col} < ($3::date::timestamp AT TIME ZONE $4)`;
  const [t, sales, canceled, items, typed, expenses, moves, buys, newProducts, newCustomers, sessions, restock, bySeller, byDay] = await Promise.all([
    q('SELECT name,city,state FROM tenants WHERE id=$1', [tenantId]),
    q(`SELECT x.sale_number,x.created_at,x.total_cents,x.discount_cents,x.payment_method,x.description,c.name customer,COALESCE(sl.name,u.name) seller
       FROM sales x LEFT JOIN customers c ON c.id=x.customer_id JOIN users u ON u.id=x.created_by LEFT JOIN users sl ON sl.id=x.seller_id
       WHERE x.tenant_id=$1 AND x.canceled_at IS NULL AND ${inRange('x.created_at')} ORDER BY x.created_at`, range),
    q(`SELECT count(*)::int n,COALESCE(sum(total_cents),0)::int total FROM sales WHERE tenant_id=$1 AND canceled_at IS NOT NULL AND ${inRange('created_at')}`, range),
    q(`SELECT i.name || COALESCE(' ' || i.variant_name,'') name,sum(i.quantity)::int qty,sum(i.total_cents)::int total,
         sum(CASE WHEN i.unit_cost_cents IS NULL THEN NULL ELSE i.unit_cost_cents*i.quantity END)::int cost,bool_and(i.unit_cost_cents IS NOT NULL) known
       FROM sale_items i JOIN sales x ON x.id=i.sale_id WHERE x.tenant_id=$1 AND x.canceled_at IS NULL AND ${inRange('x.created_at')}
       GROUP BY 1 ORDER BY 3 DESC,1`, range),
    q(`SELECT count(*)::int n,COALESCE(sum(total_cents),0)::int total FROM sales x WHERE x.tenant_id=$1 AND x.canceled_at IS NULL AND ${inRange('x.created_at')}
       AND NOT EXISTS (SELECT 1 FROM sale_items i WHERE i.sale_id=x.id)`, range),
    q(`SELECT m.created_at,m.category,m.note,m.method,m.amount_cents,u.name who FROM cash_movements m JOIN users u ON u.id=m.created_by
       WHERE m.tenant_id=$1 AND m.kind='expense' AND m.canceled_at IS NULL AND ${inRange('m.created_at')} ORDER BY m.created_at`, range),
    q(`SELECT kind,count(*)::int n,sum(amount_cents)::int total FROM cash_movements WHERE tenant_id=$1 AND kind IN ('withdrawal','deposit') AND canceled_at IS NULL AND ${inRange('created_at')} GROUP BY kind`, range),
    q(`SELECT p.name || COALESCE(' ' || v.name,'') name,sum(s.quantity)::int qty,sum(s.quantity*COALESCE(s.unit_cost_cents,0))::int total,bool_and(s.unit_cost_cents IS NOT NULL) known
       FROM stock_movements s JOIN products p ON p.id=s.product_id LEFT JOIN product_variants v ON v.id=s.variant_id
       WHERE s.tenant_id=$1 AND s.kind='entry' AND ${inRange('s.created_at')} GROUP BY 1 ORDER BY 3 DESC,1`, range),
    q(`SELECT name,barcode,price_cents,cost_cents,stock_qty,ask_variant,generated_barcode FROM products WHERE tenant_id=$1 AND ${inRange('created_at')} ORDER BY created_at`, range),
    q(`SELECT count(*)::int n,count(*) FILTER (WHERE source='qrcode')::int qr FROM customers WHERE tenant_id=$1 AND deleted_at IS NULL AND ${inRange('created_at')}`, range),
    q(`SELECT s.closed_at,s.expected_cash_cents,s.counted_cash_cents,u.name who FROM cash_sessions s LEFT JOIN users u ON u.id=s.closed_by
       WHERE s.tenant_id=$1 AND s.status='closed' AND ${inRange('s.closed_at')} ORDER BY s.closed_at`, range),
    q(`SELECT p.name,NULL::text variant,p.restock_pending pending,p.stock_qty,p.cost_cents FROM products p WHERE p.tenant_id=$1 AND p.active AND NOT p.ask_variant AND p.restock_pending>0
       UNION ALL SELECT p.name,v.name,v.restock_pending,v.stock_qty,p.cost_cents FROM product_variants v JOIN products p ON p.id=v.product_id
       WHERE p.tenant_id=$1 AND p.active AND v.active AND v.restock_pending>0 ORDER BY 1,2`, [tenantId]),
    q(`SELECT COALESCE(sl.name,u.name) name,count(*)::int n,sum(x.total_cents)::int total FROM sales x JOIN users u ON u.id=x.created_by LEFT JOIN users sl ON sl.id=x.seller_id
       WHERE x.tenant_id=$1 AND x.canceled_at IS NULL AND ${inRange('x.created_at')} GROUP BY 1 ORDER BY 3 DESC`, range),
    q(`SELECT to_char(x.created_at AT TIME ZONE $4,'YYYY-MM-DD') d,count(*)::int n,sum(x.total_cents)::int total FROM sales x
       WHERE x.tenant_id=$1 AND x.canceled_at IS NULL AND ${inRange('x.created_at')} GROUP BY 1 ORDER BY 1`, range)
  ]);
  const byMethod = {};
  for (const s of sales.rows) { const m = byMethod[s.payment_method] ||= { n: 0, total: 0 }; m.n++; m.total += s.total_cents; }
  const expByCat = {};
  for (const e of expenses.rows) { const k = e.category || 'Outros'; expByCat[k] = (expByCat[k] || 0) + e.amount_cents; }
  const salesTotal = sales.rows.reduce((a, s) => a + s.total_cents, 0);
  const expensesTotal = expenses.rows.reduce((a, e) => a + e.amount_cents, 0);
  const itemsTotal = items.rows.reduce((a, i) => a + i.total, 0), itemsCost = items.rows.reduce((a, i) => a + (i.cost || 0), 0);
  const costKnown = items.rows.every(i => i.known);
  return {
    kind, day, period: per, store: t.rows[0] || {}, timezone: TZ,
    sales: sales.rows, sales_total: salesTotal, discounts: sales.rows.reduce((a, s) => a + (s.discount_cents || 0), 0),
    by_method: byMethod, by_seller: bySeller.rows, by_day: byDay.rows, canceled: canceled.rows[0],
    items: items.rows, items_total: itemsTotal, items_cost: itemsCost, cost_known: costKnown, typed: typed.rows[0],
    expenses: expenses.rows, expenses_total: expensesTotal, expenses_by_category: expByCat,
    moves: Object.fromEntries(moves.rows.map(m => [m.kind, m])),
    purchases: buys.rows, purchases_total: buys.rows.reduce((a, b) => a + b.total, 0),
    new_products: newProducts.rows, new_customers: newCustomers.rows[0], sessions: sessions.rows, restock: restock.rows,
    balance: salesTotal - expensesTotal
  };
}

const table = (head, rows, empty, foot = '') => rows.length
  ? `<table style="width:100%;border-collapse:collapse;font-size:13px;margin:6px 0 14px"><thead><tr>${head.map(h => `<th style="text-align:${h.r ? 'right' : 'left'};border-bottom:2px solid #e5e7eb;padding:6px 4px;color:#4b5563;font-weight:600">${esc(h.t ?? h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td style="text-align:${head[i].r ? 'right' : 'left'};border-bottom:1px solid #f0f1f3;padding:6px 4px;vertical-align:top">${c}</td>`).join('')}</tr>`).join('')}${foot}</tbody></table>`
  : `<p style="color:#6b7280;font-size:13px;margin:4px 0 14px">${esc(empty)}</p>`;
const R = t => ({ t, r: true });
const h2 = t => `<h2 style="font-size:16px;margin:22px 0 4px;color:#111827">${esc(t)}</h2>`;
const kpi = (label, value, color = '#111827') => `<td style="padding:10px;border:1px solid #e5e7eb;border-radius:10px;background:#fafafa"><div style="font-size:12px;color:#6b7280">${esc(label)}</div><div style="font-size:19px;font-weight:700;color:${color}">${value}</div></td>`;
const hhmm = (d, tz) => new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: tz });

export function reportHtml(d) {
  const long = d.kind !== 'daily';
  // Lucro bruto só dos itens com custo cadastrado (xerox, avulsos e produtos sem custo ficam de fora).
  const withCost = d.items.filter(i => i.known && i.cost != null), noCost = d.items.filter(i => !(i.known && i.cost != null));
  const gross = withCost.length ? withCost.reduce((a, i) => a + i.total - i.cost, 0) : null;
  const title = `Relatório ${KIND_LABEL[d.kind]} · ${d.store.name || ''}`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f2f3f5;font-family:Arial,Helvetica,sans-serif;color:#111827">
<div style="max-width:720px;margin:0 auto;padding:18px">
<div style="background:#fff;border-radius:14px;padding:20px">
<div style="font-size:12px;color:#f25c1f;font-weight:700;letter-spacing:.04em">FICOU PRONTO · RELATÓRIO ${esc(KIND_LABEL[d.kind].toUpperCase())}</div>
<h1 style="font-size:22px;margin:4px 0 2px">${esc(d.store.name || '')}</h1>
<div style="color:#4b5563;font-size:14px">${esc(d.period.title)}</div>

<table style="width:100%;border-collapse:separate;border-spacing:6px;margin:14px -6px 0"><tr>
${kpi(`Vendas (${d.sales.length})`, brl(d.sales_total), '#027a48')}${kpi('Saídas', brl(d.expenses_total), '#b42318')}${kpi('Saldo (vendas − saídas)', brl(d.balance))}
</tr><tr>
${kpi('Compras de estoque', brl(d.purchases_total), '#b54708')}${kpi('Lucro bruto dos produtos', gross == null ? '—' : brl(gross))}${kpi('Descontos dados', brl(d.discounts))}
</tr></table>
${noCost.length && d.items.length ? `<p style="font-size:12px;color:#6b7280">Lucro bruto sem: ${noCost.map(i => esc(i.name)).join(', ')} (sem preço de custo).</p>` : ''}

${h2('Balanço por forma de pagamento')}
${table(['Forma', R('Vendas'), R('Total')], Object.entries(d.by_method).map(([k, v]) => [esc(METHODS[k] || k), v.n, brl(v.total)]), 'Nenhuma venda no período.')}
${d.moves.withdrawal || d.moves.deposit ? `<p style="font-size:13px;color:#4b5563">${['withdrawal', 'deposit'].filter(k => d.moves[k]).map(k => `${MOVE[k]}: ${brl(d.moves[k].total)} (${d.moves[k].n})`).join(' · ')}</p>` : ''}
${d.canceled.n ? `<p style="font-size:13px;color:#b42318">Vendas canceladas: ${d.canceled.n} (${brl(d.canceled.total)}) — fora dos totais.</p>` : ''}

${long && d.by_day.length ? h2('Vendas por dia') + table(['Dia', R('Vendas'), R('Total')], d.by_day.map(x => [dmy(x.d), x.n, brl(x.total)]), '') : ''}
${d.by_seller.length ? h2('Por vendedor') + table(['Vendedor', R('Vendas'), R('Total')], d.by_seller.map(x => [esc(x.name), x.n, brl(x.total)]), '') : ''}

${h2('Produtos vendidos')}
${table(['Item', R('Qtd'), R('Total'), R('Custo')], d.items.map(i => [esc(i.name), i.qty, brl(i.total), i.cost != null ? brl(i.cost) : '—']), 'Nenhum item vendido.')}
${d.typed.n ? `<p style="font-size:12px;color:#6b7280">Mais ${d.typed.n} venda(s) lançada(s) só com valor digitado, sem itens: ${brl(d.typed.total)}.</p>` : ''}

${h2(`Saídas lançadas (${brl(d.expenses_total)})`)}
${long ? table(['Categoria', R('Total')], Object.entries(d.expenses_by_category).sort((a, b) => b[1] - a[1]).map(([k, v]) => [esc(k), brl(v)]), 'Nenhuma saída no período.')
    : table(['Hora', 'Categoria', 'Descrição', 'Forma', R('Valor')], d.expenses.map(e => [hhmm(e.created_at, d.timezone), esc(e.category), esc(e.note), esc(METHODS[e.method] || ''), brl(e.amount_cents)]), 'Nenhuma saída no dia.')}

${h2(`Compras de estoque (${brl(d.purchases_total)})`)}
${table(['Item', R('Qtd'), R('Custo total')], d.purchases.map(b => [esc(b.name), b.qty, b.known ? brl(b.total) : brl(b.total) + ' *']), 'Nenhuma entrada de estoque no período.')}
${d.purchases.some(b => !b.known) ? '<p style="font-size:12px;color:#6b7280">* entrada sem custo informado (conta como zero).</p>' : ''}
${d.kind === 'monthly' ? `<p style="font-size:13px"><b>Total gasto no mês:</b> saídas ${brl(d.expenses_total)} + compras de estoque ${brl(d.purchases_total)} = <b>${brl(d.expenses_total + d.purchases_total)}</b>. <span style="color:#6b7280">Se a compra também foi lançada como saída no caixa, ela aparece nos dois.</span></p>` : ''}

${h2('Produtos novos cadastrados')}
${table(['Produto', 'Código', R('Venda'), R('Custo'), R('Estoque')], d.new_products.map(p => [esc(p.name) + (p.ask_variant ? ' <small>(com modelos)</small>' : ''), esc(p.barcode || '—') + (p.generated_barcode ? ' <small>(gerado)</small>' : ''), brl(p.price_cents), p.cost_cents != null ? brl(p.cost_cents) : '—', p.ask_variant ? 'por modelo' : (p.stock_qty ?? '—')]), 'Nenhum produto novo no período.')}

${h2(`Reposição — vendido e ainda não reposto (${d.restock.length})`)}
${table(['Produto', 'Modelo', R('Repor'), R('Estoque atual'), R('Custo estimado')], d.restock.map(r => [esc(r.name), esc(r.variant || ''), `<b>${r.pending}</b>`, r.stock_qty ?? '—', r.cost_cents != null ? brl(r.cost_cents * r.pending) : '—']), 'Nada para repor.')}

${d.kind === 'daily' ? h2('Vendas do dia') + table(['Nº', 'Hora', 'Vendedor', 'Cliente', 'Descrição', 'Forma', R('Valor')], d.sales.map(s => [s.sale_number, hhmm(s.created_at, d.timezone), esc(s.seller || ''), esc(s.customer || '—'), esc(s.description || ''), esc(METHODS[s.payment_method] || ''), brl(s.total_cents)]), 'Nenhuma venda no dia.') : ''}

${d.sessions.length ? h2('Fechamentos de caixa') + table(['Fechado', 'Por', R('Esperado'), R('Contado'), R('Diferença')], d.sessions.map(s => { const diff = (s.counted_cash_cents ?? 0) - (s.expected_cash_cents ?? 0); return [new Date(s.closed_at).toLocaleString('pt-BR', { timeZone: d.timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }), esc(s.who || ''), brl(s.expected_cash_cents), brl(s.counted_cash_cents), diff ? `<span style="color:${diff < 0 ? '#b42318' : '#027a48'}">${brl(diff)}</span>` : 'ok']; }), '') : ''}

<p style="font-size:13px;color:#4b5563">Clientes novos: ${d.new_customers.n}${d.new_customers.qr ? ` (${d.new_customers.qr} pelo QR code)` : ''}.</p>
<p style="font-size:11px;color:#9ca3af;margin-top:18px">Relatório automático do Ficou Pronto. Horário de ${esc(d.timezone)}. Não é documento fiscal.</p>
</div></div></body></html>`;
}

export function subjectFor(d) { return `Relatório ${KIND_LABEL[d.kind]} · ${d.store.name || ''} · ${d.period.title} · vendas ${brl(d.sales_total)}`; }

export const emailConfigured = () => !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
async function sendEmail(to, subject, html) {
  if (!emailConfigured()) throw Error('Envio de e-mail não configurado no servidor (RESEND_API_KEY e EMAIL_FROM)');
  const r = await fetch(process.env.RESEND_API_URL || 'https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, html }), signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) throw Error('Resend respondeu ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 200));
}

// Envia o que estiver pendente. Seguro para chamar várias vezes: report_runs garante um envio por período.
export async function runDueReports(q, now = new Date()) {
  const due = dueKinds(now); if (!due.length) return [];
  const tenants = (await q("SELECT id,report_email,report_daily,report_weekly,report_monthly FROM tenants WHERE report_email IS NOT NULL AND status IN ('trial','active')")).rows;
  const done = [];
  for (const t of tenants) for (const { kind, day } of due) {
    if (!t['report_' + kind]) continue;
    const key = periodFor(kind, day).key;
    // Reserva o envio; erro pode ser tentado de novo até 3 vezes, com 10 min de intervalo.
    const claim = await q(`INSERT INTO report_runs(tenant_id,kind,period_key) VALUES($1,$2,$3)
      ON CONFLICT (tenant_id,kind,period_key) DO UPDATE SET status='sending',attempts=report_runs.attempts+1,updated_at=now()
        WHERE report_runs.status='error' AND report_runs.attempts<3 AND report_runs.updated_at < now() - interval '10 minutes'
      RETURNING attempts`, [t.id, kind, key]);
    if (!claim.rowCount) continue;
    try {
      const data = await reportData(q, t.id, kind, day);
      await sendEmail(t.report_email, subjectFor(data), reportHtml(data));
      await q("UPDATE report_runs SET status='sent',error=NULL,updated_at=now() WHERE tenant_id=$1 AND kind=$2 AND period_key=$3", [t.id, kind, key]);
      done.push({ tenant: t.id, kind, key, ok: true });
    } catch (e) {
      await q("UPDATE report_runs SET status='error',error=$4,updated_at=now() WHERE tenant_id=$1 AND kind=$2 AND period_key=$3", [t.id, kind, key, String(e.message).slice(0, 300)]);
      done.push({ tenant: t.id, kind, key, ok: false });
      console.error('Relatório por e-mail falhou', { kind, key, error: String(e.message).slice(0, 120) });
    }
  }
  return done;
}

export function registerReports(app, { q, auth, roles, route, bad, valid, audit }) {
  const owner = [auth, roles('owner')];
  const staffFull = [auth, roles('owner', 'operator'), (req, res, next) => req.user.access_level === 'basic' ? bad(res, 403, 'Seu acesso não permite ver relatórios.') : next()];
  const dayParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const today = () => ymd(localNow());

  app.get('/api/store/reports/settings', ...owner, route(async (req, res) => {
    const t = (await q('SELECT report_email,report_daily,report_weekly,report_monthly FROM tenants WHERE id=$1', [req.user.tenant_id])).rows[0] || {};
    const runs = await q('SELECT kind,period_key,status,error,updated_at FROM report_runs WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 10', [req.user.tenant_id]);
    res.json({ ...t, email_configured: emailConfigured(), timezone: TZ, last_runs: runs.rows });
  }));
  app.patch('/api/store/reports/settings', ...owner, route(async (req, res) => {
    const v = valid(z.object({ report_email: z.union([z.literal(''), z.string().trim().email().max(200)]), report_daily: z.boolean(), report_weekly: z.boolean(), report_monthly: z.boolean() }).strict(), req, res); if (!v) return;
    const r = await q('UPDATE tenants SET report_email=NULLIF($1,\'\'),report_daily=$2,report_weekly=$3,report_monthly=$4 WHERE id=$5 RETURNING report_email,report_daily,report_weekly,report_monthly',
      [v.report_email.toLowerCase(), v.report_daily, v.report_weekly, v.report_monthly, req.user.tenant_id]);
    await audit(req, 'update', 'report_settings', req.user.tenant_id); res.json(r.rows[0]);
  }));
  // Prévia em HTML (o mesmo conteúdo do e-mail). date = último dia do período (padrão: hoje).
  app.get('/api/store/reports/preview', ...staffFull, route(async (req, res) => {
    const kind = ['daily', 'weekly', 'monthly'].includes(req.query.kind) ? req.query.kind : 'daily';
    const day = dayParam.safeParse(req.query.date).success ? req.query.date : today();
    const data = await reportData(q, req.user.tenant_id, kind, day);
    res.set('Cache-Control', 'no-store'); res.type('html').send(reportHtml(data));
  }));
  app.post('/api/store/reports/send', ...owner, route(async (req, res) => {
    const v = valid(z.object({ kind: z.enum(['daily', 'weekly', 'monthly']), date: dayParam.optional() }).strict(), req, res); if (!v) return;
    const t = (await q('SELECT report_email FROM tenants WHERE id=$1', [req.user.tenant_id])).rows[0];
    if (!t?.report_email) return bad(res, 400, 'Cadastre o e-mail que vai receber os relatórios.');
    const data = await reportData(q, req.user.tenant_id, v.kind, v.date || today());
    try { await sendEmail(t.report_email, subjectFor(data), reportHtml(data)); } catch (e) { return bad(res, 502, e.message); }
    await audit(req, 'send', 'report', v.kind); res.json({ sent: true, to: t.report_email });
  }));
  // Ping externo do agendador (GitHub Actions no horário) — acorda o servidor e envia o que estiver pendente.
  app.post('/api/internal/reports/run', route(async (req, res) => {
    const key = process.env.REPORTS_CRON_KEY || '', got = String(req.get('x-cron-key') || '');
    if (!key || got.length !== key.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(key))) return bad(res, 401, 'Não autorizado');
    res.json({ ran: await runDueReports(q) });
  }));
  app.get('/api/master/reports/status', auth, roles('master'), route(async (_req, res) => {
    const runs = await q('SELECT t.name,r.kind,r.period_key,r.status,r.attempts,r.error,r.updated_at FROM report_runs r JOIN tenants t ON t.id=r.tenant_id ORDER BY r.updated_at DESC LIMIT 30');
    res.json({ email_configured: emailConfigured(), cron_key_configured: !!process.env.REPORTS_CRON_KEY, timezone: TZ, runs: runs.rows });
  }));

  // Agendador interno: a cada 5 min (quando o servidor está acordado).
  const tick = () => runDueReports(q).catch(e => console.error('Agendador de relatórios', e.code || e.message));
  setTimeout(tick, 30000).unref(); setInterval(tick, 5 * 60000).unref();
  console.log('Relatórios por e-mail:', emailConfigured() ? 'envio configurado' : 'envio NÃO configurado (faltam RESEND_API_KEY/EMAIL_FROM)', '· ping externo:', process.env.REPORTS_CRON_KEY ? 'configurado' : 'sem chave');
}
