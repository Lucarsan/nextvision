// Link de avaliação do Google com medição.
//
// A mensagem de status leva /a/<código do cliente>. A página registra o clique (só quando o JavaScript
// roda no aparelho: a prévia do WhatsApp não conta) e redireciona para o link de avaliação da loja.
// Como o código vai no texto, conta igual quando a mensagem é copiada e colada à mão no WhatsApp.
// O botão "Avaliar no Google" da página do pedido também registra (origem order_page).
// O Google não diz de onde veio cada avaliação: medimos quem abriu o link; a central pode marcar quem avaliou.
import { z } from 'zod';

const TZ = process.env.STORE_TIMEZONE || 'America/Fortaleza';
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeRe = /^[0-9a-f]{10}$/;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const reviewLinkBase = () => (process.env.SHORT_LINK_BASE_URL || process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') + '/a/';

const between = col => `${col} >= ($1::date::timestamp AT TIME ZONE $3) AND ${col} < ($2::date::timestamp AT TIME ZONE $3)`;
const tf = col => `($4::uuid IS NULL OR ${col} = $4::uuid)`;

// Números por loja no período [from, to): mensagens com link, clientes que abriram, cliques, avaliações confirmadas.
export async function reviewStatsByTenant(q, { from, to, tenantId = null }) {
  const r = await q(`WITH m AS (SELECT tenant_id, count(*)::int sent, count(DISTINCT customer_id)::int sent_customers FROM customer_messages
        WHERE kind = 'status' AND review_link AND ${between('created_at')} AND ${tf('tenant_id')} GROUP BY 1),
      c AS (SELECT tenant_id, count(DISTINCT customer_id) FILTER (WHERE source = 'message')::int clicked,
          count(*) FILTER (WHERE source = 'message')::int clicks, count(*) FILTER (WHERE source = 'order_page')::int page_clicks,
          count(DISTINCT customer_id) FILTER (WHERE source = 'message' AND customer_id IN (SELECT customer_id FROM customer_messages x
            WHERE x.kind = 'status' AND x.review_link AND ${between('x.created_at')}))::int clicked_of_sent
        FROM review_client_clicks WHERE ${between('created_at')} AND ${tf('tenant_id')} GROUP BY 1),
      s AS (SELECT tenant_id, count(*)::int staff_clicks FROM review_clicks x WHERE ${between('created_at')} AND ${tf('tenant_id')}
        AND NOT EXISTS (SELECT 1 FROM review_client_clicks c WHERE c.id = x.id) GROUP BY 1),
      k AS (SELECT tenant_id, count(*)::int confirmed FROM customers WHERE ${between('review_confirmed_at')} AND ${tf('tenant_id')} GROUP BY 1)
    SELECT t.id tenant_id, COALESCE(m.sent, 0) review_sent, COALESCE(m.sent_customers, 0) review_sent_customers,
      COALESCE(c.clicked, 0) review_clicked, COALESCE(c.clicked_of_sent, 0) review_clicked_of_sent, COALESCE(c.clicks, 0) review_clicks,
      COALESCE(c.page_clicks, 0) review_page_clicks, COALESCE(s.staff_clicks, 0) review_staff_clicks, COALESCE(k.confirmed, 0) review_confirmed
    FROM tenants t LEFT JOIN m ON m.tenant_id = t.id LEFT JOIN c ON c.tenant_id = t.id LEFT JOIN s ON s.tenant_id = t.id LEFT JOIN k ON k.tenant_id = t.id
    WHERE ${tf('t.id')}`, [from, to, TZ, tenantId]);
  return new Map(r.rows.map(x => [x.tenant_id, x]));
}
export const REVIEW_KEYS = ['review_sent', 'review_sent_customers', 'review_clicked', 'review_clicked_of_sent', 'review_clicks', 'review_page_clicks', 'review_staff_clicks', 'review_confirmed'];

// Clientes com mensagem de avaliação enviada ou clique no período (uma linha por cliente).
export async function reviewCustomerRows(q, { from, to, tenantId = null }) {
  const r = await q(`WITH m AS (SELECT customer_id, min(created_at) first_sent, count(*)::int sent FROM customer_messages
        WHERE kind = 'status' AND review_link AND ${between('created_at')} AND ${tf('tenant_id')} GROUP BY 1),
      c AS (SELECT customer_id, min(created_at) first_click, max(created_at) last_click,
          count(*) FILTER (WHERE source = 'message')::int clicks, count(*) FILTER (WHERE source = 'order_page')::int page_clicks
        FROM review_client_clicks WHERE customer_id IS NOT NULL AND ${between('created_at')} AND ${tf('tenant_id')} GROUP BY 1)
    SELECT cu.id customer_id, t.name store, cu.name customer, m.first_sent, COALESCE(m.sent, 0) sent,
      c.first_click, c.last_click, COALESCE(c.clicks, 0) clicks, COALESCE(c.page_clicks, 0) page_clicks, cu.review_confirmed_at
    FROM customers cu JOIN tenants t ON t.id = cu.tenant_id
      LEFT JOIN m ON m.customer_id = cu.id LEFT JOIN c ON c.customer_id = cu.id
    WHERE (m.customer_id IS NOT NULL OR c.customer_id IS NOT NULL OR ${between('cu.review_confirmed_at')}) AND ${tf('cu.tenant_id')}
    ORDER BY (c.first_click IS NULL), c.first_click DESC, m.first_sent DESC LIMIT 2000`, [from, to, TZ, tenantId]);
  return r.rows;
}

function redirectPage({ store, url, code }) {
  const title = `Avalie ${store} no Google`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="Sua opinião ajuda muito. Leva 1 minutinho.">
<style>body{font:16px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#F7F8FA;color:#1F2937}
main{max-width:360px;padding:28px;text-align:center}a{display:inline-block;margin-top:14px;padding:14px 22px;border-radius:10px;background:#F25C1F;color:#fff;text-decoration:none;font-weight:600}</style></head>
<body><main><p>Abrindo a página de avaliação de <strong>${esc(store)}</strong> no Google…</p><a id="go" href="${esc(url)}" rel="noopener">Avaliar no Google</a></main>
<script>(function(){var url=${JSON.stringify(url).replace(/</g, '\\u003c')},code=${JSON.stringify(code)};
function rid(){try{return crypto.randomUUID()}catch(e){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return(c=='x'?r:(r&3|8)).toString(16)})}}
var visitor;try{visitor=localStorage.getItem('fp_visitor');if(!/^[0-9a-f-]{36}$/.test(visitor||'')){visitor=rid();localStorage.setItem('fp_visitor',visitor)}}catch(e){visitor=rid()}
var staff=false;try{staff=localStorage.getItem('fp_staff')==='1'}catch(e){}
var body=JSON.stringify({visitor:visitor,staff:staff}),go=function(){location.replace(url)};
try{fetch('/api/public/review/'+code+'/click',{method:'POST',headers:{'Content-Type':'application/json'},body:body,keepalive:true}).then(go,go);setTimeout(go,1200)}catch(e){go()}
})();</script></body></html>`;
}

export function registerReviewLinks(app, { q, auth, roles, route, bad, valid, audit, rateLimit, digestToken }) {
  const clickSchema = z.object({ visitor: z.string().regex(uuidRe).optional(), staff: z.boolean().default(false) });
  const pageLimit = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
  const clickLimit = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
  const byCode = code => q(`SELECT c.id, c.tenant_id, t.name, t.google_review_url FROM customers c JOIN tenants t ON t.id = c.tenant_id
    WHERE c.review_code = $1 AND c.deleted_at IS NULL AND t.status IN ('trial', 'active')`, [code]);

  app.get('/a/:code', pageLimit, route(async (req, res) => {
    const code = String(req.params.code || '').toLowerCase();
    const row = codeRe.test(code) ? (await byCode(code)).rows[0] : null;
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    if (!row || !/^https:\/\/\S+$/.test(row.google_review_url || '')) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link não encontrado</title><p style="font:16px system-ui;padding:24px">Este link de avaliação não está disponível.</p>');
    res.type('html').send(redirectPage({ store: row.name, url: row.google_review_url, code }));
  }));

  app.post('/api/public/review/:code/click', clickLimit, route(async (req, res) => {
    const code = String(req.params.code || '').toLowerCase();
    const v = valid(clickSchema, req, res); if (!v) return;
    if (!codeRe.test(code)) return res.status(204).end();
    // O mesmo aparelho abrindo de novo em menos de 10 min conta uma vez.
    await q(`INSERT INTO review_clicks(tenant_id, customer_id, source, visitor_id, staff)
      SELECT c.tenant_id, c.id, 'message', $2, $3 FROM customers c WHERE c.review_code = $1 AND c.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM review_clicks r WHERE r.customer_id = c.id AND r.source = 'message' AND $2::uuid IS NOT NULL
          AND r.visitor_id = $2::uuid AND r.created_at > now() - interval '10 minutes')`, [code, v.visitor || null, v.staff]);
    res.status(204).end();
  }));

  app.post('/api/public/orders/:token/review-click', clickLimit, route(async (req, res) => {
    const token = req.params.token;
    if (!/^[\w-]{16,100}$/.test(token)) return bad(res, 404, 'Não encontrado');
    const v = valid(clickSchema, req, res); if (!v) return;
    await q(`INSERT INTO review_clicks(tenant_id, customer_id, order_id, source, visitor_id, staff)
      SELECT o.tenant_id, o.customer_id, o.id, 'order_page', $3, $4 FROM orders o
      WHERE (o.public_token_hash = $1 OR o.share_code = $2) AND o.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM review_clicks r WHERE r.order_id = o.id AND r.source = 'order_page' AND $3::uuid IS NOT NULL
          AND r.visitor_id = $3::uuid AND r.created_at > now() - interval '10 minutes')`, [digestToken(token), token, v.visitor || null, v.staff]);
    res.status(204).end();
  }));

  // Central: marcar que o cliente avaliou (conferido no Google).
  app.patch('/api/master/customers/:id/review-confirmed', auth, roles('master'), route(async (req, res) => {
    if (!uuidRe.test(req.params.id)) return bad(res, 400, 'Cliente inválido');
    const v = valid(z.object({ confirmed: z.boolean() }).strict(), req, res); if (!v) return;
    const r = await q(`UPDATE customers SET review_confirmed_at = CASE WHEN $2 THEN COALESCE(review_confirmed_at, now()) END,
      review_confirmed_by = CASE WHEN $2 THEN COALESCE(review_confirmed_by, $3) END WHERE id = $1 RETURNING id, tenant_id, review_confirmed_at`, [req.params.id, v.confirmed, req.user.id]);
    if (!r.rowCount) return bad(res, 404, 'Cliente não encontrado');
    await audit(req, v.confirmed ? 'review_confirmed' : 'review_unconfirmed', 'customer', req.params.id, r.rows[0].tenant_id);
    res.json({ id: r.rows[0].id, review_confirmed_at: r.rows[0].review_confirmed_at });
  }));
}
