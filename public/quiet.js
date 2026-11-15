// Horário de silêncio nas telas: fora do expediente (seg a sáb 6h45-19h, Fortaleza), uma tela aberta
// e parada há 10 min deixa de se atualizar sozinha, para o banco poder dormir. Qualquer clique,
// tecla, toque ou voltar para a aba atualiza na hora. Dentro do expediente nada muda.
(function () {
  var START = 6 * 60 + 45, END = 19 * 60, DAYS = [1, 2, 3, 4, 5, 6], IDLE_MS = 10 * 60000, WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var last = Date.now();
  function open() {
    try {
      var p = {}; new Intl.DateTimeFormat('en-US', { timeZone: 'America/Fortaleza', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
      var m = (+p.hour % 24) * 60 + +p.minute; return DAYS.indexOf(WEEK.indexOf(p.weekday)) >= 0 && m >= START && m < END;
    } catch (e) { return true; }
  }
  function paused() { return !open() && Date.now() - last > IDLE_MS; }
  function touch() { var was = paused(); last = Date.now(); if (was) window.dispatchEvent(new Event('fp-wake')); }
  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'focus'].forEach(function (e) { window.addEventListener(e, touch, { capture: true, passive: true }); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) touch(); }, true);
  window.fpPollPaused = paused;
})();
