// Horário de silêncio: fora do expediente as rotinas automáticas param de consultar o banco,
// para o Neon poder "dormir" (ele suspende após 5 min sem consulta e cobra só o tempo acordado).
// Dentro do expediente nada muda. Fora dele, qualquer uso humano (loja, central, técnico,
// página do cliente) acorda tudo de novo por QUIET_IDLE_MINUTES.
//
// Configuração (opcional, por variável de ambiente):
//   QUIET_HOURS=off (desliga tudo isto)   BUSINESS_HOURS=06:45-19:00   BUSINESS_DAYS=1-6 (0=domingo ... 6=sábado)   STORE_TIMEZONE=America/Fortaleza
const TZ = process.env.STORE_TIMEZONE || 'America/Fortaleza';
const toMin = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim()); return m ? +m[1] * 60 + +m[2] : null; };

export function parseHours(spec = '06:45-19:00') {
  const [a, b] = String(spec).split('-'); const start = toMin(a), end = toMin(b);
  return start != null && end != null && start < end ? { start, end } : { start: 405, end: 1140 };
}
export function parseDays(spec = '1-6') {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const [a, b] = part.split('-').map(Number);
    if (Number.isInteger(a) && a >= 0 && a <= 6) for (let d = a; d <= (Number.isInteger(b) && b <= 6 ? b : a); d++) out.add(d);
  }
  return out.size ? out : new Set([1, 2, 3, 4, 5, 6]);
}

const HOURS = parseHours(process.env.BUSINESS_HOURS || '06:45-19:00');
const DAYS = parseDays(process.env.BUSINESS_DAYS || '1-6');
const IDLE_MS = (Number(process.env.QUIET_IDLE_MINUTES) || 10) * 60000;
// Rotinas de fundo seguem até 10 min depois do fechamento (encerramento automático das 19h).
const BACKGROUND_GRACE_MIN = 10;
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localClock(now = new Date(), tz = TZ) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map(x => [x.type, x.value]));
  return { day: WEEK.indexOf(p.weekday), minutes: (+p.hour % 24) * 60 + +p.minute };
}
export function isOpen(now = new Date(), { graceMin = 0, hours = HOURS, days = DAYS, tz = TZ } = {}) {
  const { day, minutes } = localClock(now, tz);
  return days.has(day) && minutes >= hours.start && minutes < hours.end + graceMin;
}

let lastHuman = 0;
export const markHumanActivity = (at = Date.now()) => { lastHuman = at; };
export const recentlyActive = (at = Date.now()) => at - lastHuman < IDLE_MS;
// Pode rodar rotina de fundo / falar com o banco por conta própria?
// QUIET_HOURS=off: nunca silencia. QUIET_HOURS=force: trata toda hora como fora do expediente (testes).
const MODE = process.env.QUIET_HOURS || '';
export const backgroundAllowed = (now = new Date()) => MODE === 'off' || (MODE !== 'force' && isOpen(now, { graceMin: BACKGROUND_GRACE_MIN })) || recentlyActive(now.getTime());
export const isQuiet = (now = new Date()) => !backgroundAllowed(now);
export const quietConfig = () => ({ timezone: TZ, hours: HOURS, days: [...DAYS], idle_minutes: IDLE_MS / 60000 });
