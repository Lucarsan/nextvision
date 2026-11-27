// Cancelamento da NFC-e junto com o cancelamento da venda.
// Regra nacional (Ajuste SINIEF 07/18): a NFC-e só pode ser cancelada até 30 minutos depois da autorização.
// Contamos a partir da criação do documento (antes da autorização), o que deixa uma pequena folga a favor da loja.
// Depois do prazo, a venda não se cancela mais: o caminho é troca ou devolução (crédito de troca na Garantia).
// ACBr API: POST /nfce/{id}/cancelamento { justificativa } → DfeCancelamento. Campos da resposta (status,
// codigo_status, motivo_status, numero_protocolo) a confirmar na homologação: aceitamos "registrado" ou os códigos
// 135/155 da SEFAZ como cancelado, e 573 (duplicidade de evento) como já cancelado antes.
import { acbr, AcbrError } from './acbr.js';

export const NFCE_CANCEL_MINUTES = 30;

// Último cupom vivo da venda (autorizado ou ainda em processamento), com o limite para cancelar.
export async function saleFiscal(q, saleId) {
  return (await q(`SELECT id, status, provider, provider_ref, env, created_at, created_at + interval '${NFCE_CANCEL_MINUTES} minutes' cancel_until,
      now() > created_at + interval '${NFCE_CANCEL_MINUTES} minutes' late
    FROM fiscal_documents WHERE sale_id = $1 AND model = 65 AND status IN ('pending','processing','contingency','authorized')
    ORDER BY created_at DESC LIMIT 1`, [saleId])).rows[0] || null;
}

// Mapa venda → { status, cancel_until } para a lista de vendas do caixa.
export async function salesFiscal(q, saleIds) {
  if (!saleIds.length) return new Map();
  const r = await q(`SELECT DISTINCT ON (sale_id) sale_id, status, created_at + interval '${NFCE_CANCEL_MINUTES} minutes' cancel_until
    FROM fiscal_documents WHERE sale_id = ANY($1) AND model = 65 AND status IN ('pending','processing','contingency','authorized','canceled')
    ORDER BY sale_id, created_at DESC`, [saleIds]);
  return new Map(r.rows.map(x => [x.sale_id, { status: x.status, cancel_until: x.cancel_until }]));
}

const ascii = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();

// Antes de cancelar a venda: barra o que a SEFAZ não aceita e cancela o cupom autorizado.
// Retorna null (pode seguir) ou { status, error } para responder.
export async function cancelSaleFiscal(q, saleId, reason, { fetchFn } = {}) {
  const f = await saleFiscal(q, saleId);
  if (!f) return null;
  if (f.status !== 'authorized') return { status: 409, error: 'O cupom fiscal desta venda ainda está sendo processado na SEFAZ. Espere um pouco e tente de novo.' };
  if (f.late) return { status: 409, error: `Passaram ${NFCE_CANCEL_MINUTES} minutos do cupom fiscal: a SEFAZ não aceita mais o cancelamento. Faça a troca ou devolução pela Garantia (crédito de troca).` };
  if (f.provider !== 'acbr' || !f.provider_ref) return { status: 409, error: 'Cupom fiscal sem referência no emissor. Chame o suporte para cancelar.' };
  const justificativa = ascii('Venda cancelada no caixa: ' + reason).slice(0, 255);
  let r;
  try { r = await acbr(`/nfce/${encodeURIComponent(f.provider_ref)}/cancelamento`, { method: 'POST', body: { justificativa }, ...(fetchFn ? { fetchFn } : {}), ms: 45000 }); }
  catch (e) {
    if (!(e instanceof AcbrError)) throw e;
    await q('UPDATE fiscal_documents SET error = $2, cancel_response = $3, updated_at = now() WHERE id = $1', [f.id, 'Cancelamento: ' + e.message, e.body || null]);
    return { status: 502, error: (e.timeout ? 'A SEFAZ não respondeu ao cancelamento do cupom. Tente de novo em instantes.' : 'O cupom fiscal não foi cancelado: ' + e.message) + ' A venda continua valendo.' };
  }
  const code = String(r?.codigo_status ?? r?.autorizacao?.codigo_status ?? '');
  const ok = r?.status === 'registrado' || r?.status === 'cancelado' || ['135', '155', '573'].includes(code);
  if (!ok) {
    const why = [code, r?.motivo_status || r?.mensagem].filter(Boolean).join(' - ') || r?.status || 'sem resposta';
    await q('UPDATE fiscal_documents SET error = $2, cancel_response = $3, updated_at = now() WHERE id = $1', [f.id, 'Cancelamento: ' + why, r]);
    return { status: r?.status === 'pendente' ? 409 : 502, error: (r?.status === 'pendente' ? 'O cancelamento do cupom ainda está em processamento na SEFAZ. Tente de novo em instantes.' : 'A SEFAZ não cancelou o cupom (' + why + ').') + ' A venda continua valendo.' };
  }
  await q("UPDATE fiscal_documents SET status = 'canceled', canceled_at = now(), cancel_protocol = $2, cancel_response = $3, error = NULL, updated_at = now() WHERE id = $1",
    [f.id, r?.numero_protocolo || r?.autorizacao?.numero_protocolo || null, r]);
  return null;
}
