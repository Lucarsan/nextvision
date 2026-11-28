import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createStoreFixture } from './helpers/store-fixture.js';

const skip = !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL';

// ACBr falsa: guarda o que recebeu e responde como a API real (formato da Referência).
async function fakeAcbr() {
  const seen = []; const state = { company: null, mode: 'ok' };
  const srv = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = req.headers['content-type']?.includes('json') && raw ? JSON.parse(raw) : raw;
    seen.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
    const send = (s, j) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.url === '/token') return send(200, { access_token: 'tk', expires_in: 2592000 });
    if (req.method === 'GET' && req.url === '/empresas/46383376000123') return state.company ? send(200, state.company) : send(404, { error: { message: 'Empresa não encontrada' } });
    if (req.method === 'POST' && req.url === '/empresas') { state.company = body; return send(200, body); }
    if (req.url.endsWith('/certificado') && req.method === 'PUT') return send(200, { serial_number: '1', not_valid_after: '2027-03-01T00:00:00Z', subject_name: 'GRK' });
    if (req.url.endsWith('/certificado') || req.url.endsWith('/nfce') && req.method === 'GET') return send(404, { error: { message: 'não' } });
    if (req.url.endsWith('/nfce') && req.method === 'PUT') return send(200, body);
    if (req.method === 'POST' && req.url === '/nfce') {
      if (state.mode === 'slow') return; // nunca responde → timeout do lado de cá
      if (state.mode === 'reject') return send(200, { id: 'n2', status: 'rejeitado', autorizacao: { codigo_status: 225, motivo_status: 'Falha no Schema XML' } });
      return send(200, { id: 'n1', status: 'autorizado', chave: '23261146383376000123650100000000011000000011', autorizacao: { numero_protocolo: '323260000000001', codigo_status: 100, motivo_status: 'Autorizado o uso da NF-e' } });
    }
    if (req.method === 'GET' && req.url.startsWith('/nfce?')) return send(200, { data: [{ id: 'n3', status: 'autorizado', chave: '2'.repeat(44), autorizacao: { numero_protocolo: '9' } }] });
    send(404, { error: { message: 'rota falsa ' + req.url } });
  });
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
  return { url: 'http://127.0.0.1:' + srv.address().port, seen, state, close: () => new Promise(r => { srv.closeAllConnections(); srv.close(r); }) };
}

test('ACBr: cadastro da empresa, certificado repassado sem gravar e cupom de teste na homologação', { skip, timeout: 60000 }, async () => {
  const fake = await fakeAcbr();
  const f = await createStoreFixture({ env: { ACBR_CLIENT_ID: 'cid', ACBR_CLIENT_SECRET: 'csec', ACBR_AMBIENTE: 'sandbox', ACBR_API_URL: fake.url, ACBR_AUTH_URL: fake.url + '/token' } });
  try {
    const { api, request, tenant, masterToken, db } = f;
    await db.query("UPDATE tenants SET cnpj='46383376000123', nfce_next_number=50 WHERE id=$1", [tenant]);
    await api(`/master/tenants/${tenant}/fiscal`, { method: 'PATCH', token: masterToken, body: { legal_name: 'GRK JOIAS E ACESSORIOS LTDA', state_registration: '069999999', payment_terminal_id: 'PPC930-01' } });

    let st = await api(`/master/tenants/${tenant}/acbr`, { token: masterToken });
    assert.equal(st.configured, true); assert.equal(st.environment, 'sandbox'); assert.equal(st.company, null);
    assert.match(st.problems.join(), /endereço fiscal/);
    assert.equal((await request(`/master/tenants/${tenant}/acbr`, { token: f.ownerToken })).status, 403, 'só a central');

    assert.match((await request(`/master/tenants/${tenant}/acbr/company`, { method: 'POST', token: masterToken })).data.error, /e-mail fiscal/);
    await api(`/master/tenants/${tenant}/fiscal-address`, { method: 'PATCH', token: masterToken, body: { fiscal_email: 'fiscal@audace.test', fiscal_address: { street: 'Av. Frei Cirilo', number: '3840', district: 'Messejana', city_code: '2304400', city: 'Fortaleza', cep: '60840-285' } } });
    const c = await api(`/master/tenants/${tenant}/acbr/company`, { method: 'POST', token: masterToken });
    assert.equal(c.created, true);
    assert.deepEqual(fake.state.company.endereco, { logradouro: 'Av. Frei Cirilo', numero: '3840', bairro: 'Messejana', codigo_municipio: '2304400', cidade: 'Fortaleza', uf: 'CE', codigo_pais: '1058', pais: 'Brasil', cep: '60840285' });
    assert.equal(fake.seen.find(s => s.url === '/empresas').auth, 'Bearer tk');

    const cert = await api(`/master/tenants/${tenant}/acbr/certificate`, { method: 'PUT', token: masterToken, body: { certificado: 'A'.repeat(200), password: 'segredo-do-certificado' } });
    assert.equal(cert.certificate.not_valid_after, '2027-03-01T00:00:00Z');
    const leaked = await db.query("SELECT count(*)::int n FROM audit_events WHERE action='acbr_certificate'"); assert.equal(leaked.rows[0].n, 1);
    const anywhere = await db.query("SELECT count(*)::int n FROM fiscal_documents WHERE payload::text LIKE '%segredo%'"); assert.equal(anywhere.rows[0].n, 0);

    await api(`/master/tenants/${tenant}/acbr/nfce-config`, { method: 'PUT', token: masterToken, body: {} });
    assert.deepEqual(fake.seen.at(-1).body, { CRT: 1, ambiente: 'homologacao', sefaz: { id_csc: 0, csc: '' } });
    // Com o servidor em sandbox, produção é recusada e nada vai para a ACBr.
    const sentBefore = fake.seen.length;
    const prodTry = await request(`/master/tenants/${tenant}/acbr/nfce-config`, { method: 'PUT', token: masterToken, body: { ambiente: 'producao' } });
    assert.equal(prodTry.status, 409); assert.match(prodTry.data.error, /ACBR_AMBIENTE/);
    assert.equal(fake.seen.length, sentBefore);
    assert.equal((await db.query('SELECT fiscal_env FROM tenants WHERE id=$1', [tenant])).rows[0].fiscal_env, 'homologacao');

    // Cupom de teste no crédito: série 10, número 1 da homologação, grupo card completo.
    const t1 = await api(`/master/tenants/${tenant}/acbr/test-nfce`, { method: 'POST', token: masterToken, body: { method: 'credit' } });
    assert.equal(t1.status, 'authorized'); assert.equal(t1.series, 10); assert.equal(t1.number, 1); assert.match(t1.access_key, /^\d{44}$/);
    const sent = fake.seen.find(s => s.method === 'POST' && s.url === '/nfce').body;
    assert.equal(sent.ambiente, 'homologacao'); assert.equal(sent.referencia, t1.id);
    assert.deepEqual(sent.infNFe.pag.detPag[0].card, { tpIntegra: 1, CNPJ: '16501555000157', tBand: '02', cAut: '123456', CNPJReceb: '46383376000123', idTermPag: 'PPC930-01' });

    // Rejeição fica registrada com o motivo; a numeração da produção não é tocada.
    fake.state.mode = 'reject';
    const t2 = await api(`/master/tenants/${tenant}/acbr/test-nfce`, { method: 'POST', token: masterToken, body: { method: 'pix' } });
    assert.equal(t2.status, 'rejected'); assert.equal(t2.number, 2); assert.equal(t2.error, '225 - Falha no Schema XML');
    const nums = (await db.query('SELECT nfce_next_number, nfce_hom_next_number FROM tenants WHERE id=$1', [tenant])).rows[0];
    assert.deepEqual(nums, { nfce_next_number: 50, nfce_hom_next_number: 3 });

    // Consulta depois (como após um timeout): acha pela referência e atualiza.
    await db.query("UPDATE fiscal_documents SET status='processing', provider_ref=NULL WHERE id=$1", [t2.id]);
    const sync = await api(`/master/fiscal-documents/${t2.id}/sync`, { method: 'POST', token: masterToken });
    assert.equal(sync.found, true); assert.equal(sync.status, 'authorized');
    assert.match(fake.seen.at(-1).url, new RegExp('referencia=' + t2.id));

    st = await api(`/master/tenants/${tenant}/acbr`, { token: masterToken });
    assert.equal(st.tests.length, 2); assert.deepEqual(st.problems, []); assert.ok(st.company);
  } finally { await f.cleanup(); await fake.close(); }
});

test('ACBr: com o servidor em produção, a central configura a unidade em produção (sem cupom de teste)', { skip, timeout: 60000 }, async () => {
  const fake = await fakeAcbr();
  const f = await createStoreFixture({ env: { ACBR_CLIENT_ID: 'cid', ACBR_CLIENT_SECRET: 'csec', ACBR_AMBIENTE: 'producao', ACBR_API_URL: fake.url, ACBR_AUTH_URL: fake.url + '/token' } });
  try {
    const { api, request, tenant, masterToken, db } = f;
    await db.query("UPDATE tenants SET cnpj='46383376000123' WHERE id=$1", [tenant]);
    const st = await api(`/master/tenants/${tenant}/acbr`, { token: masterToken });
    assert.equal(st.environment, 'producao'); assert.equal(st.fiscal.fiscal_env, 'homologacao');

    // CSC de produção: vai para a ACBr com ambiente producao e a unidade passa a montar o cupom em produção.
    const r = await api(`/master/tenants/${tenant}/acbr/nfce-config`, { method: 'PUT', token: masterToken, body: { id_csc: 1, csc: 'CSC-PRODUCAO', ambiente: 'producao' } });
    assert.equal(r.ambiente, 'producao');
    assert.deepEqual(fake.seen.at(-1).body, { CRT: 1, ambiente: 'producao', sefaz: { id_csc: 1, csc: 'CSC-PRODUCAO' } });
    assert.equal((await db.query('SELECT fiscal_env FROM tenants WHERE id=$1', [tenant])).rows[0].fiscal_env, 'producao');
    assert.equal((await db.query("SELECT count(*)::int n FROM audit_events WHERE action='acbr_nfce_config_producao'")).rows[0].n, 1);

    // Cupom de teste continua só na homologação do servidor.
    const t = await request(`/master/tenants/${tenant}/acbr/test-nfce`, { method: 'POST', token: masterToken, body: { method: 'cash' } });
    assert.equal(t.status, 409);
    assert.equal(fake.seen.filter(s => s.method === 'POST' && s.url === '/nfce').length, 0, 'nenhum cupom transmitido');

    // Voltar para homologação também é possível (ex.: refazer um teste).
    await api(`/master/tenants/${tenant}/acbr/nfce-config`, { method: 'PUT', token: masterToken, body: { ambiente: 'homologacao' } });
    assert.equal((await db.query('SELECT fiscal_env FROM tenants WHERE id=$1', [tenant])).rows[0].fiscal_env, 'homologacao');
  } finally { await f.cleanup(); await fake.close(); }
});
