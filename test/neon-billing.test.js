import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, costOf, neonPrices } from '../src/neon-billing.js';

test('cobrança do Neon: só períodos pagos entram, com a tabela do Launch', () => {
  const projects = [
    { project_id: 'purple-pond', periods: [
      { period_plan: 'free', period_start: '2026-11-01T00:00:00Z', consumption: [{ timeframe_start: '2026-11-10T00:00:00Z', metrics: [{ metric_name: 'compute_unit_seconds', value: 999999 }] }] },
      { period_plan: 'launch', period_start: '2026-11-16T19:43:08Z', consumption: [
        { timeframe_start: '2026-11-16T00:00:00Z', metrics: [{ metric_name: 'compute_unit_seconds', value: 3600 * 4 }, { metric_name: 'root_branch_bytes_month', value: 1e9 }] },
        { timeframe_start: '2026-11-17T00:00:00Z', metrics: [{ metric_name: 'compute_unit_seconds', value: 3600 * 6 }] }] }] },
    { project_id: 'aged-heart', periods: [{ period_plan: 'launch', period_start: '2026-11-16T19:43:08Z', consumption: [{ timeframe_start: '2026-11-16T00:00:00Z', metrics: [{ metric_name: 'compute_unit_seconds', value: 3600 }] }] }] }
  ];
  const s = summarize(projects);
  assert.equal(s.plan, 'launch');
  assert.equal(s.billing_since, '2026-11-16T19:43:08Z');
  const a = s.projects.find(p => p.id === 'purple-pond');
  assert.equal(a.cu_hours, 10);                // o uso do plano grátis não entra
  assert.equal(a.compute_usd, 1.06);           // 10 CU-h × US$ 0,106
  assert.equal(a.storage_usd, 0.35);           // 1 GB-mês × US$ 0,35
  assert.equal(a.daily['2026-11-17'].compute_usd, 0.636);
  assert.equal(s.total_usd, 1.516);            // 1,41 + 0,106
});

test('cobrança do Neon: conta só no grátis não tem plano pago', () => {
  const s = summarize([{ project_id: 'x', periods: [{ period_plan: 'free', consumption: [] }] }]);
  assert.equal(s.plan, null); assert.equal(s.total_usd, 0);
  assert.equal(costOf({ compute_unit_seconds: 7200 }, neonPrices({ NEON_CU_HOUR_PRICE: '0.2' })).compute_usd, 0.4);
});
