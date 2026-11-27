// Ficou Pronto · TEF Stone (AutoTEF) no caixa do quiosque.
// O navegador fala com o AutoTEF Slim do PC da loja (padrão http://127.0.0.1:8000) e informa cada passo ao servidor.
// Modo "simulator": um pinpad de mentira dentro da página, para treinar e testar o fluxo sem a Stone.
//   Valores de teste no simulador (centavos finais): ,51 recusa · ,52 erro do pinpad · ,53 sem resposta · ,61 Pix expira.
(function () {
  const SIM_SERIAL = 'SIM-PPC930';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const reais = c => Number((c / 100).toFixed(2));

  // Pinpad simulado: responde como o Slim (mesmas rotas e campos da documentação).
  function simulator() {
    let active = false; const pix = new Map();
    const res = (status, body) => ({ status, body });
    return async (path, body) => {
      await sleep(path === '/api/Healthcheck' ? 50 : 700);
      const cents = body && body.amount != null ? Math.round(body.amount * 100) : 0, tail = cents % 100;
      if (path === '/api/Activate') { active = true; return res(200, { stoneCode: body.stoneCode || '000000000', started: new Date().toISOString(), partnerName: body.partnerName, connectionName: body.connectionName || 'SIM', serialNumber: SIM_SERIAL }); }
      if (!active) return res(400, { responseCode: 'G002', responseReason: 'First use the activation route', messageDisplay: null });
      if (path === '/api/Healthcheck') return res(200, { started: '', stoneCode: '000000000', connectionName: 'SIM', partnerName: 'FICOUPRONTO 1.0' });
      if (path === '/api/Pay') {
        if (tail === 51) return res(400, { responseCode: 'DECL', responseReason: '1016', messageDisplay: 'Não autorizada' });
        if (tail === 52) return res(400, { responseCode: 'TECH', responseReason: '9109', messageDisplay: 'Erro no sistema' });
        if (tail === 53) throw new TypeError('Failed to fetch (simulado)');
        const atk = String(Date.now()) + String(Math.floor(Math.random() * 1000)).padStart(3, '0');
        const brand = body.accountType === 'debit' ? 'VISA DEBITO' : 'MASTER CREDITO';
        return res(200, { acquirerTransactionKey: atk, authorisationCode: String(100000 + Math.floor(Math.random() * 899999)), amount: cents, brandName: brand, productBrandCard: brand.split(' ')[0],
          maskedPrimaryAccountNumber: '************4242', transactionDateTime: new Date().toISOString().slice(0, 19), installmentType: body.installment?.type || 1,
          totalNumberOfPayments: body.installment?.number || 0, messageDisplay: 'Aprovado', merchantDocument: '00.000.000/0000-00', stoneCode: '000000000',
          clientVia: 'SIMULADOR - SEM VALOR\r\nVIA CLIENTE\r\nR$ ' + (cents / 100).toFixed(2), merchantVia: 'SIMULADOR - SEM VALOR\r\nVIA LOJA' });
      }
      if (path === '/api/Pix/Pay') {
        const id = 'SIM' + Date.now().toString(36).toUpperCase();
        pix.set(id, { cents, at: Date.now(), expire: tail === 61 });
        return res(200, { transactionId: id, amount: cents, createdIn: new Date().toLocaleString('pt-BR'), qrCodeContent: '00020101SIMULADOR' + id, qrCodeImage: null, responseCode: '0000', responseReason: 'Transaction created', wasSuccessfull: true });
      }
      if (path === '/api/Pix/Status') {
        const p = pix.get(body.transactionId); if (!p) return res(400, { responseCode: 'C404', responseReason: 'Not found' });
        await sleep(2500);
        if (p.expire) return res(400, { responseCode: 'C207', responseReason: 'The transaction has been identified. However, the transaction has expired.', MessageDisplay: null });
        return res(200, { responseCode: '0000', responseReason: 'Payment accept', wasSuccessfull: true, statusPaymentPix: 1, endTwoEndIdentification: ['E00000000SIM' + body.transactionId], transactionId: body.transactionId,
          isExpired: false, receipt: { amount: p.cents, clientVia: 'SIMULADOR - PIX SEM VALOR', merchantVia: 'SIMULADOR - PIX', merchantDocument: '00.000.000/0000-00', stoneCode: '000000000' } });
      }
      if (path === '/api/Cancel/') return res(200, {});
      return res(404, {});
    };
  }

  // Chamada ao Slim de verdade. Erro de rede (Slim parado, porta bloqueada, CORS) vira exceção "rede".
  function slim(baseUrl) {
    return async (path, body, timeoutMs = 30000) => {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await fetch(baseUrl + path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal, cache: 'no-store', targetAddressSpace: 'loopback' });
        let data = {}; const text = await r.text();
        try { data = text ? JSON.parse(text) : {}; if (typeof data === 'string') data = JSON.parse(data); } catch { data = { raw: text.slice(0, 500) }; }
        return { status: r.status, body: data };
      } finally { clearTimeout(t); }
    };
  }

  // api: função do caixa para chamar o servidor (api(path, method, body)).
  window.FpTef = function create(cfg, api) {
    const call = cfg.mode === 'simulator' ? simulator() : slim(cfg.local_url || 'http://127.0.0.1:8000');
    let serial = null;
    const code = b => (b && (b.responseCode || b.ResponseCode)) || '';
    const hint = 'Confira se o pinpad está no USB e se o programa AutoTEF (Slim) está rodando neste computador.';

    // Garante o Slim ativado (Stone Code + pinpad). Chamado antes de cada cobrança.
    async function ready() {
      let h;
      try { h = await call('/api/Healthcheck', undefined, 8000); } catch { throw Error('O pinpad não respondeu. ' + hint); }
      if (h.status === 200 && serial) return;
      if (h.status !== 200 && code(h.body) !== 'G002' && code(h.body) !== 'N404') throw Error('Pinpad com problema (' + (code(h.body) || h.status) + '). ' + hint);
      let a;
      try { a = await call('/api/Activate', { stoneCode: cfg.stone_code || '000000000', partnerName: cfg.partner_name, ...(cfg.pinpad_port ? { connectionName: cfg.pinpad_port } : {}) }, 60000); }
      catch { throw Error('O pinpad não respondeu na ativação. ' + hint); }
      if (a.status !== 200) throw Error(code(a.body) === 'N404' ? 'Pinpad não encontrado. ' + hint : code(a.body) === 'A001' ? 'Stone Code não combina com o ambiente do AutoTEF (teste x produção). Avise o suporte.' : 'Não foi possível ativar o pinpad (' + (code(a.body) || a.status) + ').');
      serial = a.body.serialNumber || serial;
    }
    // Inicialização manual (logon + carga de tabelas): força uma nova ativação do pinpad.
    async function initialize() {
      let a;
      try { a = await call('/api/Activate', { stoneCode: cfg.stone_code || '000000000', partnerName: cfg.partner_name, ...(cfg.pinpad_port ? { connectionName: cfg.pinpad_port } : {}) }, 60000); }
      catch { throw Error('O pinpad não respondeu na ativação. ' + hint); }
      if (a.status !== 200) throw Error(code(a.body) === 'N404' ? 'Pinpad não encontrado. ' + hint : code(a.body) === 'A001' ? 'Stone Code não combina com o ambiente do AutoTEF (teste x produção). Avise o suporte.' : 'Não foi possível ativar o pinpad (' + (code(a.body) || a.status) + ').');
      serial = a.body.serialNumber || serial;
      return { stone_code: a.body.stoneCode || cfg.stone_code, serial: a.body.serialNumber || null, port: a.body.connectionName || cfg.pinpad_port || null, at: new Date() };
    }
    const report = (id, kind, r) => api('/store/tef/transactions/' + id + '/result', 'POST', { kind, http: r ? r.status : 0, body: r ? r.body : null, ...(serial ? { terminal_serial: String(serial).slice(0, 40) } : {}) });

    // Cartão (crédito/débito). onStep(texto) atualiza a tela. Devolve a cobrança como o servidor registrou.
    async function payCard(method, amount_cents, installments, onStep) {
      onStep && onStep('Conectando ao pinpad…');
      await ready();
      const tx = await api('/store/tef/transactions', 'POST', { method, amount_cents, installments });
      onStep && onStep('Insira, passe ou aproxime o cartão no pinpad (' + (method === 'debit' ? 'débito' : 'crédito') + ')…');
      let r;
      try {
        r = await call('/api/Pay', { amount: reais(amount_cents), accountType: method, installment: installments > 1 ? { type: 2, number: installments } : { type: 1, number: 0 }, hasAlcoholicDrink: false }, 180000);
      } catch { return report(tx.id, 'lost', null); }
      return report(tx.id, 'card', r);
    }

    // Pix dinâmico no pinpad: gera o QR (mostrado também na tela do caixa) e espera o pagamento.
    async function payPix(amount_cents, onQr, onStep, expiresIn = 300) {
      onStep && onStep('Gerando o Pix…');
      await ready();
      const tx = await api('/store/tef/transactions', 'POST', { method: 'pix', amount_cents });
      let r;
      try { r = await call('/api/Pix/Pay', { amount: reais(amount_cents), expiresIn }, 30000); } catch { return report(tx.id, 'lost', null); }
      let cur = await report(tx.id, 'pix_created', r);
      if (cur.status !== 'pending') return cur;
      // A tela do caixa mostra o QR (e o copia e cola); o pinpad mostra o mesmo QR, se tiver tela para isso.
      if (onQr) onQr(r.body.qrCodeImage || null, r.body.qrCodeContent || ''); else if (onStep) onStep('Peça para a cliente pagar o Pix no QR Code do pinpad…');
      const until = Date.now() + (expiresIn + 60) * 1000;
      while (Date.now() < until) {
        let s;
        try { s = await call('/api/Pix/Status', { transactionId: r.body.transactionId }, (expiresIn + 30) * 1000); }
        catch { await sleep(3000); continue; }
        const c = code(s.body);
        if (s.status === 200 && c !== '0000') { await sleep(2000); continue; } // ainda aguardando
        if (s.status !== 200 && c !== 'C207') { await sleep(3000); continue; }
        return report(tx.id, 'pix_status', s);
      }
      return report(tx.id, 'lost', null); // fica pendente: o Pix ainda pode ter sido pago
    }

    // Estorno no pinpad (cartão): pede ao Slim com os dados guardados e marca no servidor.
    async function reverse(txId, onStep) {
      const d = await api('/store/tef/transactions/' + txId + '/cancel-data');
      onStep && onStep('Estorno: insira ou aproxime o MESMO cartão no pinpad…');
      await ready();
      let r;
      try { r = await call('/api/Cancel/', d.request, 180000); } catch { throw Error('O pinpad não respondeu ao estorno. A cobrança continua em Pendências do pinpad.'); }
      if (r.status !== 200) throw Error('Estorno não feito no pinpad (' + (code(r.body) || r.status) + '). A cobrança continua em Pendências do pinpad.');
      return api('/store/tef/transactions/' + txId + '/reversed', 'POST', {});
    }

    return { mode: cfg.mode, ready, initialize, payCard, payPix, reverse, get serial() { return serial; } };
  };
})();
