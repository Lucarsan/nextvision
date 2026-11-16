import test from 'node:test';
import assert from 'node:assert/strict';
const { freeHoursForecast } = await import('../src/monitoring.js');

test('horas grátis do Render: leitura oficial + serviço sempre ligado + outros pelas métricas', () => {
  const H = 3600000, monthEnd = new Date('2026-12-01T00:00:00Z');
  // Leitura do painel: 343,25 h em 16/11 11:02 UTC. Um dia depois, radar acordou 4 h: novembro fecha no limite (~750).
  const base = { baseHours: 343.25, baseAt: new Date('2026-11-16T11:02:00Z'), monthEnd };
  const a = freeHoursForecast({ ...base, now: new Date('2026-11-17T11:02:00Z'), otherHours: 4 });
  assert.equal(a.used, 371.3);           // 343,25 + 24 + 4
  assert.equal(a.other_per_day, 4);
  assert.equal(a.projected, 750);
  // Radar 5 h/dia: estoura antes do fim do mês.
  const a5 = freeHoursForecast({ ...base, now: new Date('2026-11-17T11:02:00Z'), otherHours: 5 });
  assert.ok(a5.runs_out_at && new Date(a5.runs_out_at) > new Date('2026-11-27T00:00:00Z') && new Date(a5.runs_out_at) < monthEnd);
  // Radar parado: fecha o mês dentro do limite.
  const b = freeHoursForecast({ ...base, now: new Date('2026-11-17T11:02:00Z'), otherHours: 0 });
  assert.equal(b.runs_out_at, null); assert.ok(b.projected <= 750);
  // Dezembro sem leitura oficial: o FicouPronto sozinho (744 h) + 1 h/dia de outro serviço estoura.
  const c = freeHoursForecast({ now: new Date('2026-12-05T00:00:00Z'), baseHours: 0, baseAt: new Date('2026-12-01T00:00:00Z'), otherHours: 4, monthEnd: new Date('2027-01-01T00:00:00Z') });
  assert.ok(c.runs_out_at); void H;
});
