import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretSlim, brandCode, tefForSale, STONE_CNPJ } from '../src/tef.js';

// Respostas copiadas da documentação do AutoTEF (autotef.readme.io, conferida em 25/11/2026).
const CARD_OK = { acquirerTransactionKey: '123123123123', aid: 'A0000000041234', amount: 11, brandName: 'MASTER CREDITO ', initiatorTransactionKey: '123123132321323',
  installmentType: 1, totalNumberOfPayments: 0, maskedPrimaryAccountNumber: '************1234', transactionDateTime: '2023-08-21T21:58:01', transactionType: 1,
  cardReadingType: 8, cardNeedsPassword: false, authorisationCode: '130192', messageDisplay: 'Aprovado', isVoucher: false, merchantDocument: '11.999.222/0001-99',
  merchantName: 'Integracao Partner Program', productBrandCard: 'MASTER  ', stoneCode: '123123123', clientVia: 'VIA CLIENTE', merchantVia: 'VIA LOJA' };

test('cartão aprovado: ATK, autorização, bandeira (tBand) e CNPJ da loja', () => {
  const r = interpretSlim('card', 200, CARD_OK);
  assert.equal(r.status, 'approved'); assert.equal(r.provider_tx, '123123123123'); assert.equal(r.auth_code, '130192');
  assert.equal(r.brand_name, 'MASTER CREDITO'); assert.equal(r.brand_code, '02'); assert.equal(r.card_mask, '************1234');
  assert.equal(r.merchant_document, '11999222000199'); assert.equal(r.client_receipt, 'VIA CLIENTE');
});

test('cartão: recusa, timeout, pinpad fora e sem ativação', () => {
  assert.deepEqual(interpretSlim('card', 400, { responseCode: 'DECL', responseReason: '1016', messageDisplay: 'Não autorizada' }), { status: 'declined', error_code: 'DECL', message: 'Não autorizada' });
  assert.equal(interpretSlim('card', 400, { responseCode: 'TECH', responseReason: '9109', messageDisplay: 'Erro no sistema' }).status, 'error');
  assert.equal(interpretSlim('card', 400, { ResponseCode: 'N404', ResponseReason: 'Port: COM4' }).error_code, 'N404');
  assert.equal(interpretSlim('card', 400, { ResponseCode: 'G002', ResponseReason: 'First use the activation route' }).status, 'error');
  assert.equal(interpretSlim('card', 200, { messageDisplay: 'x' }).status, 'error', 'sem ATK não é aprovação');
  assert.equal(interpretSlim('lost', 0, null).status, 'unknown');
});

test('Pix: QR criado, pago (endToEndId) e expirado', () => {
  const c = interpretSlim('pix_created', 200, { transactionId: 'A1905dVYthVr9LZwqMvdDtJMzBQ', amount: 1, qrCodeContent: '000201...', responseCode: '0000', responseReason: 'Transaction created', wasSuccessfull: true });
  assert.equal(c.status, 'pending'); assert.equal(c.provider_tx, 'A1905dVYthVr9LZwqMvdDtJMzBQ');
  const p = interpretSlim('pix_status', 200, { responseCode: '0000', responseReason: 'Payment accept', wasSuccessfull: true, statusPaymentPix: 1,
    endTwoEndIdentification: ['E18236120202501242059s06fe69d556'], transactionId: 'd188', isExpired: false,
    receipt: { amount: 100, merchantDocument: '16.501.555/0001-57', stoneCode: '190427471', clientVia: 'C', merchantVia: 'M' } });
  assert.equal(p.status, 'approved'); assert.equal(p.e2e_id, 'E18236120202501242059s06fe69d556'); assert.equal(p.stone_code, '190427471');
  assert.equal(interpretSlim('pix_status', 400, { responseCode: 'C207', responseReason: 'expired', MessageDisplay: null }).status, 'expired');
});

test('bandeiras para a NFC-e', () => {
  assert.equal(brandCode('VISA DEBITO'), '01'); assert.equal(brandCode('MASTER CREDITO '), '02'); assert.equal(brandCode('MAESTRO'), '02');
  assert.equal(brandCode('ELO CREDITO'), '06'); assert.equal(brandCode('HIPERCARD'), '07'); assert.equal(brandCode('AMEX'), '03');
  assert.equal(brandCode('BANDEIRA NOVA'), '99'); assert.equal(brandCode('', null), null);
});

test('dados para a NFC-e: credenciadora Stone, autorização e terminal', () => {
  const t = { id: 'x', mode: 'production', method: 'credit', amount_cents: 4900, brand_code: '02', auth_code: '130192', provider_tx: 'ATK1', terminal_serial: '03000398', stone_code: '123' };
  assert.deepEqual(tefForSale(t), { method: 'credit', amount_cents: 4900, acquirer_cnpj: STONE_CNPJ, brand: '02', auth: '130192', terminal_id: '03000398', nsu: 'ATK1', tef_transaction_id: 'x' });
  const pix = tefForSale({ ...t, method: 'pix', e2e_id: 'E123', mode: 'simulator' });
  assert.equal(pix.brand, null); assert.equal(pix.auth, 'E123'); assert.equal(pix.simulated, true);
});
