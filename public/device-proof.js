// Acesso só no computador da unidade: pede ao agente Ficou Pronto deste PC (ponte local) uma prova de uso único.
// Só é chamado quando a central responde code "device_required"; em redes sem a trava nada muda.
window.fpDeviceProof = async function fpDeviceProof() {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    // targetAddressSpace: aviso ao Chrome de que o pedido vai para este próprio computador (acesso à rede local).
    const r = await fetch('http://127.0.0.1:47833/proof', { method: 'POST', signal: ctrl.signal, cache: 'no-store', targetAddressSpace: 'loopback' });
    const d = await r.json().catch(() => ({}));
    return r.ok && typeof d.proof === 'string' ? d.proof : '';
  } catch { return ''; } finally { clearTimeout(timer); }
};
// Faz o login; se a rede exigir o PC da unidade, busca a prova e tenta de novo uma vez.
window.fpLoginWithDevice = async function fpLoginWithDevice(url, body) {
  const send = b => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  let r = await send(body), d = await r.json().catch(() => ({}));
  if (r.status === 403 && d.code === 'device_required') {
    const proof = await window.fpDeviceProof();
    if (proof) { r = await send({ ...body, device_proof: proof }); d = await r.json().catch(() => ({})); }
    if (!r.ok && d.code === 'device_required') d.error = proof
      ? 'Este computador não está liberado para esta unidade. Fale com o suporte.'
      : 'Este acesso só funciona no computador da unidade, com o Ficou Pronto ligado. Se este é o computador da unidade e o navegador perguntar, permita o acesso a apps deste dispositivo.';
  }
  return { r, d };
};
