// Acesso só no computador da unidade: pede ao agente Ficou Pronto deste PC (ponte local) uma prova de uso único.
// Só é chamado quando a central responde code "device_required"; em redes sem a trava nada muda.
// Sem opções novas do fetch (ex.: targetAddressSpace): versões mais antigas do Chrome recusam o pedido na hora.
window.fpDeviceProof = async function fpDeviceProof() {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch('http://127.0.0.1:47833/proof', { method: 'POST', signal: ctrl.signal, cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    return r.ok && typeof d.proof === 'string' ? d.proof : '';
  } catch { return ''; } finally { clearTimeout(timer); }
};
// Faz o login; se a unidade exigir o PC dela, busca a prova e tenta de novo uma vez.
// device_retry marca a segunda tentativa: só ela entra em "tentativas recusadas" (a primeira sempre vai sem prova).
window.fpLoginWithDevice = async function fpLoginWithDevice(url, body, onWait) {
  const send = b => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  let r = await send(body), d = await r.json().catch(() => ({}));
  if (r.status === 403 && d.code === 'device_required') {
    if (onWait) onWait('Conferindo este computador…');
    const proof = await window.fpDeviceProof();
    r = await send({ ...body, ...(proof ? { device_proof: proof } : {}), device_retry: true }); d = await r.json().catch(() => ({}));
    if (onWait) onWait('');
    if (!r.ok && d.code === 'device_required') d.error = proof
      ? 'Este computador não está liberado para esta unidade. Fale com o suporte.'
      : 'Este acesso só funciona no computador da unidade, com o Ficou Pronto ligado. Se este é o computador da unidade e o navegador perguntar, permita o acesso a apps deste dispositivo.';
  }
  return { r, d };
};
