// Central → Dispositivos → "Arquivos à distância": listar pastas, enviar e trazer arquivos dos computadores das lojas.
// O PC recebe o pedido pelo sinal de vida (até 30 s) e depois responde em segundos enquanto houver pedidos.
// Usa os utilitários globais do app.js: api, el, safe, msg, token.
(() => {
  const FIRST = '0.6.0';
  const vcmp = (a, b) => { const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
  const BASE = 'C:\\ProgramData\\FicouPronto';
  const PLACES = [['Recebidos', BASE + '\\recebidos'], ['Ficou Pronto', BASE], ['Registros (logs)', BASE + '\\logs'], ['Backups', BASE + '\\backups'], ['Área de trabalho pública', 'C:\\Users\\Public\\Desktop'], ['Disco C:', 'C:\\']];
  const KIND = { list: 'Listar pasta', push: 'Enviar ao PC', pull: 'Trazer do PC' };
  const STATUS = { pending: 'aguardando o PC', running: 'em andamento', done: 'concluído', failed: 'falhou', cancelled: 'cancelado', expired: 'vencido' };
  const size = n => n == null ? '' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
  const dt = d => d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const join = (folder, name) => folder.replace(/\\+$/, '') + '\\' + name;
  const parent = p => { const t = p.replace(/\\+$/, ''); const i = t.lastIndexOf('\\'); return i <= 2 ? t.slice(0, 3) : t.slice(0, i); };
  let timer = null;

  window.remoteFilesPanel = async (tid) => {
    const box = el('remotePanel'); if (!box) return;
    clearInterval(timer); timer = null;
    const devs = (await api('/master/tenants/' + tid + '/devices')).filter(d => !d.revoked_at);
    if (!devs.length) { box.innerHTML = '<p>Nenhum computador ativado nesta loja.</p>'; return; }
    const saved = sessionStorage.getItem('ct_remote_dev');
    box.innerHTML = '<label>Computador<select id="rfDev">' + devs.map(d => '<option value="' + safe(d.id) + '"' + (d.id === saved ? ' selected' : '') + '>' + safe(d.name) + (d.enabled ? '' : ' (bloqueado)') + '</option>').join('') + '</select></label>'
      + '<div id="rfWarn"></div>'
      + '<div class="ct-note">Atalhos: ' + PLACES.map(([l, p]) => '<button type="button" class="secondary" data-rf-place="' + safe(p) + '">' + safe(l) + '</button>').join(' ') + '</div>'
      + '<label>Pasta ou arquivo no PC<input id="rfPath" value="' + safe(BASE + '\\recebidos') + '" spellcheck="false"></label>'
      + '<p><button type="button" id="rfList">Listar pasta</button> <button type="button" class="secondary" id="rfPull">Trazer este arquivo</button></p>'
      + '<details style="margin:8px 0"><summary><b>Enviar arquivo para o PC</b></summary><label>Arquivo<input id="rfFile" type="file"></label><label>Pasta de destino no PC<input id="rfDest" value="' + safe(BASE + '\\recebidos') + '" spellcheck="false"></label>'
      + '<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="rfOver" style="width:auto;margin:0"> Substituir se já existir (senão salva como "nome (2)")</label><p><button type="button" id="rfSend">Enviar</button> <span id="rfProg" class="ct-note"></span></p></details>'
      + '<div id="rfListing"></div><h3>Pedidos recentes</h3><div id="rfJobs">Carregando…</div>';
    const dev = () => el('rfDev').value;
    const url = p => '/master/tenants/' + tid + '/devices/' + dev() + '/remote' + p;
    let shownList = null;

    const showListing = job => {
      const out = el('rfListing'); if (!job) { out.innerHTML = ''; return; }
      const ent = (job.result && job.result.entries) || [];
      const dirs = ent.filter(e => e.type === 'dir').sort((a, b) => a.name.localeCompare(b.name)), files = ent.filter(e => e.type === 'file').sort((a, b) => a.name.localeCompare(b.name));
      out.innerHTML = '<h3>Conteúdo de <code>' + safe(job.path) + '</code></h3><p class="ct-note">Lido em ' + dt(job.finished_at) + (job.result && job.result.truncated ? ' · mostrando os primeiros 1000 itens' : '') + '</p>'
        + '<div style="overflow:auto;max-height:360px"><table><thead><tr><th>Nome</th><th>Tamanho</th><th>Alterado</th><th></th></tr></thead><tbody>'
        + '<tr><td colspan="4"><button type="button" class="secondary" data-rf-open="' + safe(parent(job.path)) + '">⬆ Pasta acima</button></td></tr>'
        + dirs.map(e => '<tr><td>📁 ' + safe(e.name) + '</td><td></td><td>' + safe(e.modified ? dt(e.modified) : '') + '</td><td><button type="button" class="secondary" data-rf-open="' + safe(join(job.path, e.name)) + '">Abrir</button></td></tr>').join('')
        + files.map(e => '<tr><td>' + safe(e.name) + '</td><td>' + size(e.size) + '</td><td>' + safe(e.modified ? dt(e.modified) : '') + '</td><td><button type="button" class="secondary" data-rf-get="' + safe(join(job.path, e.name)) + '">Trazer</button></td></tr>').join('')
        + (ent.length ? '' : '<tr><td colspan="4">Pasta vazia.</td></tr>') + '</tbody></table></div>';
      out.querySelectorAll('[data-rf-open]').forEach(b => b.onclick = () => { el('rfPath').value = b.dataset.rfOpen; doList(); });
      out.querySelectorAll('[data-rf-get]').forEach(b => b.onclick = () => { el('rfPath').value = b.dataset.rfGet; doPull(); });
    };

    const refresh = async () => {
      if (!document.body.contains(box) || !el('rfDev')) { clearInterval(timer); timer = null; return; }
      let data; try { data = await api(url('')); } catch (e) { el('rfJobs').textContent = e.message; return; }
      const d = data.device;
      el('rfWarn').innerHTML = !d.agent_version || vcmp(d.agent_version, FIRST) < 0
        ? '<p class="ct-note">⚠ Este computador está com o agente ' + safe(d.agent_version || 'desconhecido') + '. Arquivos à distância começam na ' + FIRST + ': atualize o agente (acima) ou rode o instalador novo no PC uma vez.</p>' : '';
      const jobs = data.jobs;
      el('rfJobs').innerHTML = jobs.length ? '<div style="overflow:auto"><table><thead><tr><th>Pedido</th><th>Tipo</th><th>Caminho</th><th>Situação</th><th></th></tr></thead><tbody>' + jobs.map(j => '<tr><td>' + dt(j.created_at) + '</td><td>' + safe(KIND[j.kind]) + '</td><td><code>' + safe(j.kind === 'push' ? join(j.path, j.file_name || '') : j.path) + '</code>' + (j.bytes != null ? '<br><small>' + size(j.bytes) + '</small>' : '') + '</td><td>' + safe(STATUS[j.status] || j.status)
        + (j.error ? '<br><small>' + safe(j.error) + '</small>' : '') + (j.result && j.result.saved_path ? '<br><small>salvo em ' + safe(j.result.saved_path) + '</small>' : '') + '</td><td>'
        + (j.file_ready ? '<button type="button" data-rf-dl="' + safe(j.id) + '">Baixar</button> ' : '')
        + (j.kind === 'list' && j.status === 'done' ? '<button type="button" class="secondary" data-rf-show="' + safe(j.id) + '">Ver</button> ' : '')
        + (j.status === 'pending' ? '<button type="button" class="secondary" data-rf-cancel="' + safe(j.id) + '">Cancelar</button>' : '') + '</td></tr>').join('') + '</tbody></table></div>'
        : '<p>Nenhum pedido ainda.</p>';
      el('rfJobs').querySelectorAll('[data-rf-dl]').forEach(b => b.onclick = () => download(b.dataset.rfDl));
      el('rfJobs').querySelectorAll('[data-rf-show]').forEach(b => b.onclick = () => { shownList = b.dataset.rfShow; showListing(jobs.find(j => j.id === shownList)); });
      el('rfJobs').querySelectorAll('[data-rf-cancel]').forEach(b => b.onclick = async () => { b.disabled = true; try { await api(url('/jobs/' + b.dataset.rfCancel), 'DELETE'); await refresh(); } catch (e) { msg(e.message); } });
      // A última listagem pedida aparece sozinha quando o PC responde.
      if (shownList) { const j = jobs.find(x => x.id === shownList); if (j && j.status === 'done') { showListing(j); shownList = null; } else if (j && ['failed', 'expired', 'cancelled'].includes(j.status)) { el('rfListing').innerHTML = '<p>Não foi possível listar: ' + safe(j.error || STATUS[j.status]) + '</p>'; shownList = null; } }
      const busy = jobs.some(j => ['pending', 'running'].includes(j.status));
      if (busy && !timer) timer = setInterval(refresh, 3000); else if (!busy && timer) { clearInterval(timer); timer = null; }
    };

    const download = async id => {
      try {
        const r = await fetch('/api' + url('/jobs/' + id + '/file'), { headers: { Authorization: 'Bearer ' + token } });
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw Error(j.error || 'Erro ao baixar'); }
        const name = decodeURIComponent((/filename\*=UTF-8''([^;]+)/.exec(r.headers.get('content-disposition') || '') || [])[1] || 'arquivo');
        const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      } catch (e) { msg(e.message); }
    };
    const doList = async () => {
      try { const j = await api(url('/list'), 'POST', { path: el('rfPath').value.trim() }); shownList = j.id; el('rfListing').innerHTML = '<p>Pedido enviado. O PC responde no próximo sinal de vida (até 30 s)…</p>'; await refresh(); } catch (e) { msg(e.message); }
    };
    const doPull = async () => {
      try { await api(url('/pull'), 'POST', { path: el('rfPath').value.trim() }); msg('Pedido enviado. Quando o PC mandar, aparece "Baixar" nos pedidos recentes.'); await refresh(); } catch (e) { msg(e.message); }
    };
    const doSend = () => {
      const file = el('rfFile').files[0]; if (!file) return msg('Escolha um arquivo.');
      const q = '?folder=' + encodeURIComponent(el('rfDest').value.trim()) + '&name=' + encodeURIComponent(file.name) + (el('rfOver').checked ? '&overwrite=1' : '');
      const x = new XMLHttpRequest(); x.open('POST', '/api' + url('/push') + q); x.setRequestHeader('Authorization', 'Bearer ' + token); x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.upload.onprogress = e => { if (e.lengthComputable) el('rfProg').textContent = 'Enviando para a central: ' + Math.round(e.loaded / e.total * 100) + '%'; };
      x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch { } el('rfSend').disabled = false;
        if (x.status >= 200 && x.status < 300) { el('rfProg').textContent = 'Na central. O PC baixa no próximo sinal de vida (até 30 s).'; el('rfFile').value = ''; refresh(); } else { el('rfProg').textContent = ''; msg(j.error || 'Erro ao enviar'); } };
      x.onerror = () => { el('rfSend').disabled = false; el('rfProg').textContent = ''; msg('Falha de conexão ao enviar.'); };
      el('rfSend').disabled = true; x.send(file);
    };
    box.querySelectorAll('[data-rf-place]').forEach(b => b.onclick = () => { el('rfPath').value = b.dataset.rfPlace; doList(); });
    el('rfList').onclick = doList; el('rfPull').onclick = doPull; el('rfSend').onclick = doSend;
    el('rfDev').onchange = () => { sessionStorage.setItem('ct_remote_dev', dev()); el('rfListing').innerHTML = ''; shownList = null; clearInterval(timer); timer = null; refresh(); };
    await refresh();
  };
})();
