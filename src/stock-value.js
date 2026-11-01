// Valor do estoque: página rápida, protegida por um login e senha próprios (além do login da loja),
// para termos uma ideia do que está parado no estoque.
// - Conta só o que está cadastrado e ainda não foi vendido (estoque atual > 0).
// - Custo total, preço de venda total e lucro esperado; itens com maior e menor lucro.
// - O login e o hash da senha ficam em variáveis de ambiente (STOCK_VALUE_LOGIN e STOCK_VALUE_PASSWORD_HASH).
//   A senha nunca fica no código.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

const sameText = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

export function registerStockValue(app, { q, route, bad, valid, audit, guard, tid }) {
  const attempts = rateLimit({ windowMs: 15 * 60000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Muitas tentativas. Tente de novo em 15 minutos.' } });

  app.post('/api/store/stock/value', ...guard, attempts, route(async (req, res) => {
    const v = valid(z.object({ login: z.string().max(100), password: z.string().max(200) }).strict(), req, res); if (!v) return;
    const login = process.env.STOCK_VALUE_LOGIN || 'admin', hash = process.env.STOCK_VALUE_PASSWORD_HASH || '';
    if (!hash) return bad(res, 503, 'A senha desta página ainda não foi configurada.');
    const okLogin = sameText(v.login.trim().toLowerCase(), login.toLowerCase());
    const okPass = await bcrypt.compare(v.password, hash);
    if (!okLogin || !okPass) { await audit(req, 'denied', 'stock_value', tid(req)); return bad(res, 401, 'Login ou senha incorretos.'); }

    // Uma linha por item em estoque: produto simples (ou peça) ou cada modelo de um produto com modelos.
    // O modelo usa o preço e o custo do produto.
    const rows = (await q(`SELECT p.id product_id,NULL::uuid variant_id,p.name,NULL::text variant,p.kind,p.barcode,p.stock_qty qty,p.cost_cents,p.price_cents
        FROM products p WHERE p.tenant_id=$1 AND p.active AND NOT p.ask_variant AND p.stock_qty>0
      UNION ALL
      SELECT p.id,v.id,p.name,v.name,p.kind,p.barcode,v.stock_qty,p.cost_cents,p.price_cents
        FROM product_variants v JOIN products p ON p.id=v.product_id
        WHERE p.tenant_id=$1 AND p.active AND v.active AND p.ask_variant AND v.stock_qty>0`, [tid(req)])).rows;

    const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);
    // Peça: o "preço" é o do serviço (mão de obra junto), não preço de revenda; entra só no custo.
    const products = rows.filter(r => r.kind !== 'part'), parts = rows.filter(r => r.kind === 'part');
    const withCost = products.filter(r => r.cost_cents != null);
    const items = withCost.map(r => {
      const unit = r.price_cents - r.cost_cents;
      return { name: r.name, variant: r.variant, barcode: r.barcode, qty: r.qty, cost_cents: r.cost_cents, price_cents: r.price_cents,
        unit_profit_cents: unit, total_profit_cents: unit * r.qty, margin_pct: r.price_cents > 0 ? Math.round((unit / r.price_cents) * 1000) / 10 : null };
    });
    const byUnit = [...items].sort((a, b) => b.unit_profit_cents - a.unit_profit_cents || b.margin_pct - a.margin_pct);
    const top = byUnit.slice(0, 10);
    const bottom = [...items].sort((a, b) => a.unit_profit_cents - b.unit_profit_cents || a.margin_pct - b.margin_pct).slice(0, 10);

    await audit(req, 'view', 'stock_value', tid(req));
    res.set('Cache-Control', 'no-store');
    res.json({
      generated_at: new Date().toISOString(),
      products: {
        items: products.length, units: sum(products, r => r.qty),
        cost_cents: sum(withCost, r => r.cost_cents * r.qty),
        sale_cents: sum(products, r => r.price_cents * r.qty),
        sale_with_cost_cents: sum(withCost, r => r.price_cents * r.qty),
        profit_cents: sum(items, r => r.total_profit_cents),
        without_cost: products.filter(r => r.cost_cents == null).map(r => ({ name: r.name, variant: r.variant, qty: r.qty, price_cents: r.price_cents })),
        without_price: products.filter(r => !r.price_cents).length,
        below_cost: items.filter(r => r.unit_profit_cents < 0).length
      },
      parts: { items: parts.length, units: sum(parts, r => r.qty), cost_cents: sum(parts.filter(r => r.cost_cents != null), r => r.cost_cents * r.qty), without_cost: parts.filter(r => r.cost_cents == null).length },
      top, bottom,
      // Onde está o dinheiro parado: maiores valores de custo em estoque.
      most_capital: [...items].sort((a, b) => b.cost_cents * b.qty - a.cost_cents * a.qty).slice(0, 10).map(r => ({ ...r, stock_cost_cents: r.cost_cents * r.qty }))
    });
  }));
}
