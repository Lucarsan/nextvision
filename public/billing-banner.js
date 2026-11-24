// Aviso de cobrança para o dono (painel da loja e painel da rede): vencida ou vencendo em até 5 dias,
// com o link do Asaas para pagar. E, se a loja estiver bloqueada pela cobrança, o link para liberar.
(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dmy = d => String(d || '').slice(0, 10).split('-').reverse().slice(0, 2).join('/');
  const brl = c => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const okUrl = u => /^https:\/\//.test(u || '');
  const box = (html, bad) => { const d = document.createElement('div'); d.className = 'fp-billing-banner'; d.setAttribute('role', 'status');
    d.style.cssText = 'margin:0 0 14px;padding:12px 16px;border-radius:14px;font-size:14px;line-height:1.45;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;' + (bad ? 'background:#FEF2F2;color:#991B1B;border:1px solid #FCA5A5' : 'background:#FFF7ED;color:#9A3412;border:1px solid #FED7AA');
    d.innerHTML = html; return d; };
  const payBtn = url => okUrl(url) ? '<a href="' + esc(url) + '" target="_blank" rel="noopener" style="display:inline-block;padding:7px 14px;border-radius:10px;background:#111827;color:#fff;font-weight:600;text-decoration:none">Pagar agora</a>' : '';
  window.fpBillingBanner = async ({ path, token, before }) => {
    try {
      const r = await fetch('/api' + path, { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' }); if (!r.ok) return;
      const d = await r.json(), today = d.today || new Date().toISOString().slice(0, 10);
      const soon = new Date(Date.parse(today + 'T12:00:00Z') + 5 * 86400000).toISOString().slice(0, 10);
      const list = (d.charges || []).filter(c => c.overdue || c.due_date <= soon); if (!list.length || !before) return;
      document.querySelectorAll('.fp-billing-banner').forEach(n => n.remove());
      const c = list[0], late = list.filter(x => x.overdue);
      const text = late.length
        ? '<span><b>' + (late.length > 1 ? late.length + ' cobranças vencidas' : 'Cobrança vencida em ' + dmy(c.due_date)) + '</b> · ' + esc(c.description) + ' · ' + brl(c.value_cents) + (c.pay_until ? '. Para não bloquear o sistema, pague até <b>' + dmy(c.pay_until) + '</b>.' : '.') + '</span>'
        : '<span>' + esc(c.description) + ' de <b>' + brl(c.value_cents) + '</b> vence ' + (c.due_date === today ? '<b>hoje</b>' : 'em <b>' + dmy(c.due_date) + '</b>') + '.</span>';
      before.before(box(text + payBtn(c.invoice_url), late.length > 0));
    } catch { /* aviso é opcional */ }
  };
  // Bloqueio pela cobrança: mostra o link para pagar (vem no 403 como pay_url).
  window.fpBlockedNotice = (target, err) => {
    if (!target || !err || !okUrl(err.pay_url)) return false;
    document.querySelectorAll('.fp-billing-banner').forEach(n => n.remove());
    target.before(box('<span><b>' + esc(err.message || 'Acesso bloqueado por pagamento em atraso.') + '</b></span>' + payBtn(err.pay_url), true));
    return true;
  };
})();
