let token=sessionStorage.getItem('nv_token')||'',user=null,view='';
const el=id=>document.getElementById(id),safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path,method='GET',data){let r=await fetch('/api'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:data?JSON.stringify(data):undefined});let j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'Erro na solicitação');return j;}
function msg(x){el('feedback').textContent=x||''}
const field=(label,id,type='text')=>'<label>'+label+'<input id="'+id+'" type="'+type+'" required></label>';
const table=(cols,rows)=>'<div style="overflow:auto"><table><thead><tr>'+cols.map(x=>'<th>'+safe(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';
const tr=c=>'<tr>'+c.map(v=>'<td>'+safe(v)+'</td>').join('')+'</tr>';
const nicheLabels={general:'Serviços em geral',electronics:'Assistência técnica',automotive:'Oficina automotiva',bodyshop:'Funilaria e pintura',carwash:'Lava-jato',pet:'Pet shop',food:'Delivery e alimentação'};
const nicheSelect=(id,value='general')=>'<select id="'+id+'">'+Object.entries(nicheLabels).map(([key,label])=>'<option value="'+key+'" '+(value===key?'selected':'')+'>'+label+'</option>').join('')+'</select>';
async function show(page){view=page;msg('');el('pageTitle').textContent=page;el('pageSub').textContent=PAGE_SUB[page]||'';el('headActions').innerHTML='';document.querySelectorAll('.ct-nav-btn[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===page));try{let h='';if(page==='Visão geral'){await overview();return;}if(page==='Dispositivos'){const stores=await api('/master/tenants');h='<section><h2>Selecione a loja</h2><label>Loja<select id="deviceTenant">'+stores.map(t=>'<option value="'+safe(t.id)+'">'+safe(t.name)+' — '+safe(t.status)+'</option>').join('')+'</select></label><p>O código de instalação é válido por 30 minutos e pode ser usado apenas uma vez.</p><button id="activationBtn" '+(!stores.length?'disabled':'')+'>Gerar código de ativação</button><div id="activationResult" role="status"></div></section><section><h2>Computadores vinculados</h2><div id="deviceList">Selecione uma loja para consultar os equipamentos.</div></section><section><h2>Câmeras vinculadas ao computador</h2><div id="cameraDeviceList">Carregando câmeras…</div></section>';render(h);if(!stores.length)return;
 const refreshDevices=async()=>{const rows=await api('/master/tenants/'+el('deviceTenant').value+'/devices');el('deviceList').innerHTML=rows.length?'<div style="overflow-x:auto"><table><thead><tr><th>Dispositivo</th><th>Status</th><th>Última comunicação</th><th>Ações</th></tr></thead><tbody>'+rows.map(d=>'<tr><td>'+safe(d.name)+'</td><td>'+safe(d.revoked_at?'Revogado':d.enabled?'Liberado':'Bloqueado')+'</td><td>'+safe(d.last_seen_at?new Date(d.last_seen_at).toLocaleString('pt-BR'):'Nunca')+'</td><td>'+(d.revoked_at?'Sem ações':'<button class="secondary" data-device="'+safe(d.id)+'" data-enabled="'+String(!d.enabled)+'">'+(d.enabled?'Bloquear':'Liberar')+'</button> <button class="secondary" data-revoke="'+safe(d.id)+'">Revogar</button>')+'</td></tr>').join('')+'</tbody></table></div>':'<p>Nenhum dispositivo vinculado.</p>';
 el('deviceList').querySelectorAll('[data-device]').forEach(b=>b.onclick=async()=>{try{await api('/master/tenants/'+el('deviceTenant').value+'/devices/'+b.dataset.device,'PATCH',{enabled:b.dataset.enabled==='true'});await refreshDevices()}catch(e){msg(e.message)}});
 el('deviceList').querySelectorAll('[data-revoke]').forEach(b=>b.onclick=async()=>{if(!confirm('Revogar permanentemente este dispositivo? Será necessário ativá-lo novamente.'))return;try{await api('/master/tenants/'+el('deviceTenant').value+'/devices/'+b.dataset.revoke+'/revoke','POST');await refreshDevices()}catch(e){msg(e.message)}});
 };
 const refreshCameras=async()=>{
 const tid=el('deviceTenant').value;
 const [cams,devs]=await Promise.all([api('/cameras'),api('/master/tenants/'+tid+'/devices')]);
 const mine=cams.filter(c=>c.tenant_id===tid);
 el('cameraDeviceList').innerHTML=mine.length?mine.map(c=>'<div style="padding:12px 0;border-bottom:1px solid #e4e9ef"><strong>'+safe(c.name)+'</strong><label>Computador responsável<select data-camera-id="'+safe(c.id)+'"><option value="">Não vinculado</option>'+devs.filter(d=>!d.revoked_at).map(d=>'<option value="'+safe(d.id)+'" '+(d.id===c.device_id?'selected':'')+'>'+safe(d.name)+(d.enabled?'':' (bloqueado)')+'</option>').join('')+'</select></label></div>').join(''):'<p>Esta loja ainda não tem câmeras cadastradas.</p>';
 el('cameraDeviceList').querySelectorAll('[data-camera-id]').forEach(sel=>sel.onchange=async()=>{
 try{await api('/master/tenants/'+tid+'/cameras/'+sel.dataset.cameraId+'/device','PATCH',{device_id:sel.value||null});msg('Câmera vinculada ao dispositivo.');await refreshCameras()}catch(e){msg(e.message);await refreshCameras()}
 });
 };
 el('deviceTenant').onchange=()=>{el('activationResult').textContent='';Promise.all([refreshDevices(),refreshCameras()]).catch(e=>msg(e.message))};
 el('activationBtn').onclick=async()=>{try{const data=await api('/master/tenants/'+el('deviceTenant').value+'/activation-codes','POST');const panel=el('activationResult');panel.replaceChildren();const note=document.createElement('p');note.textContent='Código único (exibido somente agora, expira em '+new Date(data.expires_at).toLocaleTimeString('pt-BR')+'):';const code=document.createElement('code');code.style.cssText='display:block;font-size:1.15rem;overflow-wrap:anywhere;padding:12px';code.textContent=data.activation_code;const copy=document.createElement('button');copy.className='secondary';copy.textContent='Copiar código';copy.onclick=()=>navigator.clipboard.writeText(data.activation_code).then(()=>msg('Código copiado')).catch(()=>msg('Não foi possível copiar'));panel.append(note,code,copy)}catch(e){msg(e.message)}};
 await Promise.all([refreshDevices(),refreshCameras()]);return;}
 if(page==='Técnicos'){const [technicians,tenants]=await Promise.all([api('/master/technicians'),api('/master/tenants')]);h='<section><h2>Criar conta técnica</h2><form id="techForm">'+field('Nome','techName')+field('E-mail','techEmail','email')+field('Senha inicial (12+ caracteres)','techPassword','password')+'<button>Criar técnico</button></form></section><section><h2>Atribuir loja</h2><form id="assignmentForm"><label>Técnico<select id="techId">'+technicians.map(t=>'<option value="'+safe(t.id)+'">'+safe(t.name)+'</option>').join('')+'</select></label><label>Loja<select id="tenantId">'+tenants.map(t=>'<option value="'+safe(t.id)+'">'+safe(t.name)+'</option>').join('')+'</select></label>'+field('Observações da instalação','techNotes')+'<button '+(!technicians.length||!tenants.length?'disabled':'')+'>Autorizar instalação</button></form></section><section><h2>Equipe técnica</h2>'+table(['Nome','E-mail','Lojas atribuídas'],technicians.map(t=>tr([t.name,t.email,String(t.assignments)])))+'<p>Acesso técnico: /tecnico.html. Cada técnico vê apenas lojas atribuídas.</p></section>';render(h);el('techForm').onsubmit=async e=>{e.preventDefault();try{await api('/master/technicians','POST',{name:el('techName').value,email:el('techEmail').value,password:el('techPassword').value});show('Técnicos')}catch(err){msg(err.message)}};el('assignmentForm').onsubmit=async e=>{e.preventDefault();try{await api('/master/technicians/'+el('techId').value+'/assignments','POST',{tenant_id:el('tenantId').value,notes:el('techNotes').value});show('Técnicos')}catch(err){msg(err.message)}};return;}
 if(page==='Configurações'){
 const settings=await api('/master/settings');render('<section><h2>Contato comercial</h2><p>WhatsApp para solicitações de alteração de plano, com código do país e DDD, somente números.</p><form id="salesForm"><label>WhatsApp dos atendentes<input id="salesWhatsApp" inputmode="tel" value="'+safe(settings.sales_whatsapp||'')+'" placeholder="55 + DDD + número"></label><button>Salvar contato</button></form></section>');
 el('salesForm').onsubmit=async e=>{e.preventDefault();try{await api('/master/settings','PUT',{sales_whatsapp:el('salesWhatsApp').value.replace(/[^0-9]/g,'')});msg('Contato comercial atualizado.')}catch(error){msg(error.message)}};return;
 }
 if(page==='Lojas'){el('headActions').innerHTML='<button type="button" class="ct-btn" id="newStoreBtn">Nova loja</button>';el('newStoreBtn').onclick=newStoreDialog;
 const [rows,stats]=await Promise.all([api('/master/tenants'),api('/master/stats')]);
 h='<section><h2>Lojas cadastradas</h2><div style="overflow:auto"><table><thead><tr><th>Nome</th><th>Nicho</th><th>Status</th><th>Câmeras instaladas / plano</th><th>Ação</th></tr></thead><tbody>'+rows.map(x=>'<tr><td>'+safe(x.name)+'<br><small>'+safe(x.slug)+'</small></td><td>'+nicheSelect('niche-'+x.id,x.niche||'general')+'</td><td><select id="status-'+x.id+'">'+[['trial','Em teste'],['active','Ativa'],['past_due','Em atraso'],['suspended','Bloqueada']].map(([key,label])=>'<option value="'+key+'" '+(x.status===key?'selected':'')+'>'+label+'</option>').join('')+'</select></td><td>'+safe(x.cameras_count)+' / <input id="limit-'+x.id+'" type="number" min="1" max="128" value="'+(x.camera_limit||1)+'" style="width:80px"></td><td><button class="secondary" data-save-niche="'+x.id+'">Salvar</button></td></tr>').join('')+'</tbody></table></div><p>Alterar o nicho não exclui nem modifica processos e pedidos existentes.</p></section>';
 render(h);

 document.querySelectorAll('[data-save-niche]').forEach(button=>button.onclick=async()=>{button.disabled=true;try{await api('/master/tenants/'+button.dataset.saveNiche,'PATCH',{niche:el('niche-'+button.dataset.saveNiche).value,status:el('status-'+button.dataset.saveNiche).value,camera_limit:Number(el('limit-'+button.dataset.saveNiche).value)});msg('Loja, acesso e limite atualizados.')}catch(error){msg(error.message)}finally{button.disabled=false}});
 }
else if(page==='Usuários'){const stores=await api('/master/tenants');h='<section><form id="form"><label>Loja<select id="tenant" required><option value="">Selecione uma loja</option>'+stores.map(s=>'<option value="'+safe(s.id)+'">'+safe(s.name)+' ('+safe(s.slug)+')</option>').join('')+'</select></label>'+field('Nome','name')+field('E-mail','memberEmail','email')+field('Senha temporária (12+ caracteres)','memberPassword','password')+'<button>Criar</button></form></section>';render(h);formSubmit(async()=>api('/master/tenants/'+el('tenant').value+'/users','POST',{name:el('name').value,email:el('memberEmail').value,password:el('memberPassword').value,role:'owner'}));}
else if(page==='Cobranças'){let rows=await api('/master/invoices');render(''+table(['Loja','Valor','Status','Vencimento'],rows.map(x=>tr([x.tenant_name,'R$ '+(x.amount_cents/100).toFixed(2),x.status,x.due_date]))));}
else if(page==='Câmeras'){await cameraAdmin();return;}
else if(page==='Clientes'){let rows=await api('/customers');render('<section><form id="form">'+field('Nome','name')+field('E-mail','email','email')+field('Telefone','phone')+'<button>Adicionar</button></form></section>'+table(['Nome','E-mail','Telefone'],rows.map(x=>tr([x.name,x.email,x.phone]))));formSubmit(()=>api('/customers','POST',{name:el('name').value,email:el('email').value,phone:el('phone').value}));}
else if(page==='Processos'){let rows=await api('/processes');render(''+(user.role==='owner'?'<section><form id="form">'+field('Nome','name')+field('Etapas separadas por vírgula','steps')+'<button>Criar processo</button></form></section>':'')+table(['Processo','Etapas'],rows.map(x=>tr([x.name,x.steps.join(' → ')]))));if(user.role==='owner')formSubmit(()=>api('/processes','POST',{name:el('name').value,steps:el('steps').value.split(',').map(s=>s.trim()).filter(Boolean)}));}
else if(page==='Pedidos'){let [orders,customers,processes,cameras]=await Promise.all([api('/orders'),api('/customers'),api('/processes'),api('/cameras')]);const options=(items)=>items.map(x=>'<option value="'+safe(x.id)+'">'+safe(x.name)+'</option>').join('');h='<section><h2>Novo pedido</h2><form id="form"><label>Cliente<select id="customer">'+options(customers)+'</select></label><label>Processo<select id="process">'+options(processes)+'</select></label><label>Câmera<select id="camera"><option value="">Sem câmera</option>'+options(cameras)+'</select></label><button>Criar pedido</button></form><p id="newLink"></p></section>'+orders.map(o=>'<section><h2>'+safe(o.customer)+' — '+safe(o.process)+'</h2><p>Status: '+safe(o.status)+' · Etapa: '+safe(o.steps[o.step_index]||'Finalizado')+'</p>'+(['queued','live','paused'].includes(o.status)?'<div class="row">'+(o.status==='queued'?'<button data-id="'+o.id+'" data-action="start">Iniciar</button>':'')+(o.status==='live'?'<button data-id="'+o.id+'" data-action="pause">Pausar</button><button data-id="'+o.id+'" data-action="advance">Próxima etapa</button><button data-id="'+o.id+'" data-action="complete">Concluir</button>':'')+(o.status==='paused'?'<button data-id="'+o.id+'" data-action="resume">Retomar</button>':'')+'</div>':'')+'</section>').join('');render(h);formSubmit(async()=>{let r=await api('/orders','POST',{customer_id:el('customer').value,process_id:el('process').value,camera_id:el('camera').value||null});await show('Pedidos');el('newLink').innerHTML='<a target="_blank" rel="noopener" href="'+safe(r.tracking_url)+'">Link do cliente: '+safe(r.tracking_url)+'</a>'});document.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{try{await api('/orders/'+b.dataset.id+'/transition','POST',{action:b.dataset.action});show('Pedidos')}catch(e){msg(e.message)}});}
}catch(e){msg(e.message)}}
function render(h){el('content').innerHTML=h}
function formSubmit(fn){el('form').onsubmit=async e=>{e.preventDefault();try{await fn();if(view!=='Pedidos')show(view)}catch(err){msg(err.message)}}}
const PAGES={"Visão geral": "<path d=\"M3 12h4l3-8 4 16 3-8h4\"/>", "Lojas": "<path d=\"M4 9h16l-1-5H5zM5 9v11h14V9M10 20v-6h4v6\"/>", "Dispositivos": "<rect x=\"3\" y=\"4\" width=\"18\" height=\"12\" rx=\"2\"/><path d=\"M8 20h8M12 16v4\"/>", "Câmeras": "<path d=\"M15 10l5-3v10l-5-3M3 7h12v10H3z\"/>", "Técnicos": "<path d=\"M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z\"/>", "Usuários": "<circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4 21c1-4 4-6 8-6s7 2 8 6\"/>", "Cobranças": "<rect x=\"3\" y=\"6\" width=\"18\" height=\"13\" rx=\"2\"/><path d=\"M3 10h18M7 15h4\"/>", "Configurações": "<circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2\"/>"};
const PAGE_SUB={'Visão geral':'Todas as lojas estão funcionando e em dia?','Lojas':'Cadastro, plano e acesso de cada loja','Dispositivos':'Computadores das lojas e códigos de ativação','Câmeras':'Câmeras instaladas por loja','Técnicos':'Equipe de instalação e lojas atribuídas','Usuários':'Acessos dos lojistas','Cobranças':'Faturas registradas','Configurações':'Contato comercial e ajustes da central'};
function enter(u){if(u.role==='technician'){location.replace('/tecnico.html');return;}if(u.role!=='master'){location.replace('/loja.html');return;}user=u;
 el('nav').innerHTML=Object.entries(PAGES).map(([name,icon])=>'<button type="button" class="ct-nav-btn" data-page="'+safe(name)+'"><svg aria-hidden="true" viewBox="0 0 24 24">'+icon+'</svg><span>'+safe(name)+'</span></button>').join('');
 el('nav').querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>show(b.dataset.page));show('Visão geral');}

async function cameraAdmin(){
 const stores=await api('/master/tenants');
 render('<section><label>Loja<select id="cameraTenant">'+stores.map(store=>'<option value="'+store.id+'">'+safe(store.name)+'</option>').join('')+'</select></label><p id="cameraCapacity"></p><form id="masterCameraForm"><label>Nome da câmera<input id="masterCameraName" required></label><label>Setor<input id="masterCameraStation"></label><label>Computador autorizado<select id="masterCameraDevice"></select></label><button>Cadastrar câmera</button></form></section><section><h2>Câmeras instaladas</h2><div id="adminCameraList"></div></section>');
 if(!stores.length)return;
 const refresh=async()=>{
  const id=el('cameraTenant').value;
  const [cameras,devices,tenants]=await Promise.all([api('/cameras'),api('/master/tenants/'+id+'/devices'),api('/master/tenants')]);
  const mine=cameras.filter(camera=>camera.tenant_id===id),store=tenants.find(store=>store.id===id);
  el('cameraCapacity').textContent=mine.length+' de '+store.camera_limit+' câmeras autorizadas no plano.';
  el('masterCameraDevice').innerHTML='<option value="">Vincular depois</option>'+devices.filter(device=>device.enabled&&!device.revoked_at).map(device=>'<option value="'+device.id+'">'+safe(device.name)+'</option>').join('');
  el('adminCameraList').innerHTML=mine.map(camera=>'<form class="admin-camera" data-id="'+camera.id+'"><label>Nome<input name="name" value="'+safe(camera.name)+'"></label><label>Setor<input name="station" value="'+safe(camera.station||'')+'"></label><p>'+safe(camera.enabled?'Liberada':'Bloqueada')+' · '+safe(camera.status)+'</p><button>Salvar dados</button> <button type="button" class="secondary" data-toggle-camera="'+camera.id+'" data-enabled="'+!camera.enabled+'">'+(camera.enabled?'Bloquear':'Liberar')+'</button> <button type="button" class="secondary" data-replace-camera="'+camera.id+'">Trocar equipamento</button> <button type="button" class="secondary" data-remove-camera="'+camera.id+'">Remover câmera</button></form>').join('')||'<p>Nenhuma câmera cadastrada.</p>';
  el('adminCameraList').querySelectorAll('form').forEach(form=>form.onsubmit=async e=>{e.preventDefault();try{await api('/cameras/'+form.dataset.id,'PATCH',Object.fromEntries(new FormData(form)));msg('Câmera atualizada.');await refresh()}catch(error){msg(error.message)}});
  el('adminCameraList').querySelectorAll('[data-toggle-camera]').forEach(button=>button.onclick=async()=>{try{await api('/cameras/'+button.dataset.toggleCamera,'PATCH',{enabled:button.dataset.enabled==='true'});await refresh()}catch(error){msg(error.message)}});
  el('adminCameraList').querySelectorAll('[data-replace-camera]').forEach(button=>button.onclick=async()=>{if(!confirm('Iniciar troca do equipamento? A transmissão será bloqueada até a configuração e liberação da câmera substituta. O histórico será preservado.'))return;try{await api('/cameras/'+button.dataset.replaceCamera,'PATCH',{replacement:true});await refresh()}catch(error){msg(error.message)}});
  el('adminCameraList').querySelectorAll('[data-remove-camera]').forEach(button=>button.onclick=async()=>{if(!confirm('Remover a câmera, bloquear sua transmissão e liberar uma vaga no plano? O histórico será preservado.'))return;try{await api('/cameras/'+button.dataset.removeCamera,'DELETE');await refresh()}catch(error){msg(error.message)}});
 };
 el('cameraTenant').onchange=()=>refresh().catch(error=>msg(error.message));
 el('masterCameraForm').onsubmit=async e=>{e.preventDefault();try{await api('/cameras','POST',{tenant_id:el('cameraTenant').value,name:el('masterCameraName').value,station:el('masterCameraStation').value,device_id:el('masterCameraDevice').value||null});el('masterCameraName').value='';el('masterCameraStation').value='';await refresh();msg('Câmera cadastrada.');el('masterCameraName').focus()}catch(error){msg(error.message)}};
 await refresh();
}

el('logout').onclick=()=>{sessionStorage.removeItem('nv_token');location.replace('/');};
if(!token)location.replace('/#entrar');else api('/me').then(enter).catch(()=>{sessionStorage.removeItem('nv_token');location.replace('/#entrar')});

// ---- Visão geral: responde "todas as lojas estão funcionando e em dia?" ----
const chip=(kind,text)=>'<span class="ct-chip '+kind+'">'+safe(text)+'</span>';
const ago=iso=>{if(!iso)return 'nunca';const m=Math.round((Date.now()-new Date(iso))/60000);if(m<2)return 'agora';if(m<60)return 'há '+m+' min';const h=Math.round(m/60);return h<48?'há '+h+'h':'há '+Math.round(h/24)+' dias';};
function storeHealth(s){
 const issues=[];
 const agent=!s.devices?{k:'muted',t:'Sem agente'}:s.devices_online?{k:'ok',t:'Online'}:{k:'bad',t:'Offline '+ago(s.last_seen_at)};
 if(s.devices&&!s.devices_online)issues.push({t:'Computador offline',next:'Chamar técnico'});
 const access={trial:{k:'muted',t:'Em teste'},active:{k:'ok',t:'Ativa'},past_due:{k:'warn',t:'Em atraso'},suspended:{k:'bad',t:'Bloqueada'}}[s.status]||{k:'muted',t:s.status};
 if(s.status==='past_due')issues.push({t:'Pagamento em atraso',next:'Cobrar no WhatsApp'});
 if(s.status==='suspended')issues.push({t:'Loja bloqueada',next:'Revisar bloqueio'});
 if(!s.cameras)issues.push({t:'Sem câmera cadastrada',next:'Agendar instalação'});
 return {agent,access,issues};
}
async function overview(){
 el('headActions').innerHTML='<button type="button" class="ct-btn" id="newStoreBtn">Nova loja</button>';
 el('newStoreBtn').onclick=newStoreDialog;
 const rows=await api('/master/overview');
 const health=rows.map(s=>({s,h:storeHealth(s)}));
 const needing=health.filter(x=>x.h.issues.length);
 const filter=window.__ctFilter||'all';
 const camsTotal=rows.reduce((a,s)=>a+s.cameras,0),camsPlan=rows.reduce((a,s)=>a+s.camera_limit,0);
 const withAgent=rows.filter(s=>s.devices),online=withAgent.filter(s=>s.devices_online);
 const answer=!rows.length?['Nenhuma loja cadastrada ainda','Cadastre a primeira loja para começar.','muted']
  :needing.length?['Quase tudo certo: '+needing.length+(needing.length>1?' lojas precisam':' loja precisa')+' de você',needing.map(x=>x.s.name+': '+x.h.issues[0].t.toLowerCase()).join(' · '),'warn']
  :['Tudo certo: todas as lojas funcionando e em dia',rows.length+' loja(s) acompanhadas','ok'];
 const kpi=(label,value,note,kind='')=>'<div class="ct-kpi"><span>'+safe(label)+'</span><strong>'+safe(value)+'</strong><em class="'+kind+'">'+safe(note)+'</em></div>';
 const list=(filter==='action'?needing:health);
 render('<section class="ct-answer '+answer[2]+'"><div class="ct-answer-icon" aria-hidden="true">'+(answer[2]==='ok'?'✓':'!')+'</div><div><strong>'+safe(answer[0])+'</strong><span>'+safe(answer[1])+'</span></div></section>'
 +'<section class="ct-card ct-kpis">'
 +kpi('Lojas',rows.length,rows.filter(s=>s.status==='trial').length+' em teste')
 +kpi('Câmeras instaladas',camsTotal+'/'+camsPlan,'do total contratado')
 +kpi('Computadores online',withAgent.length?online.length+'/'+withAgent.length:'—',withAgent.length?(withAgent.length-online.length)+' offline':'nenhum agente ativado',withAgent.length>online.length?'bad':'')
 +kpi('Pedidos hoje',rows.reduce((a,s)=>a+s.orders_today,0),rows.reduce((a,s)=>a+s.orders_live,0)+' em atendimento agora')
 +'</section>'
 +'<section class="ct-card"><div class="ct-card-head"><h2>Lojas</h2><div class="ct-seg" role="tablist" aria-label="Filtrar lojas"><button type="button" role="tab" data-filter="all" aria-selected="'+(filter==='all')+'">Todas ('+rows.length+')</button><button type="button" role="tab" data-filter="action" aria-selected="'+(filter==='action')+'">Precisam de ação ('+needing.length+')</button></div></div>'
 +'<div class="ct-table-wrap"><table class="ct-table"><thead><tr><th>Loja</th><th>Câmeras</th><th>Computador</th><th>Pedidos hoje</th><th>Acesso</th><th>Próxima ação</th></tr></thead><tbody>'
 +(list.length?list.map(({s,h})=>'<tr><td><div class="ct-store"><strong>'+safe(s.name)+'</strong><span>'+safe(nicheLabels[s.niche]||s.niche)+' · /'+safe(s.slug)+'</span></div></td><td>'+s.cameras+' de '+s.camera_limit+'</td><td>'+chip(h.agent.k,h.agent.t)+'</td><td>'+s.orders_today+(s.orders_live?' <span class="ct-muted">('+s.orders_live+' ao vivo)</span>':'')+'</td><td>'+chip(h.access.k,h.access.t)+'</td><td>'+(h.issues.length?'<button type="button" class="ct-link" data-goto="Lojas">'+safe(h.issues[0].next)+'</button>':'<span class="ct-muted">—</span>')+'</td></tr>').join(''):'<tr><td colspan="6" class="ct-empty">Nenhuma loja nesta lista.</td></tr>')
 +'</tbody></table></div><p class="ct-note">"Computador" mostra o agente ativado pela central. Lojas que usam o supervisor do piloto não enviam sinal de vida e aparecem como "Sem agente". Cobrança automática ainda não integrada.</p></section>');
 document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{window.__ctFilter=b.dataset.filter;overview().catch(e=>msg(e.message))});
 document.querySelectorAll('[data-goto]').forEach(b=>b.onclick=()=>show(b.dataset.goto));
}
function newStoreDialog(){
 const d=el('ctDialog');
 d.innerHTML='<form id="newStoreForm" class="ct-form"><div class="ct-card-head"><h2>Nova loja</h2><button type="button" class="ct-x" aria-label="Fechar" id="closeDialog">×</button></div>'
 +'<label>Nome da loja<input id="nsName" required maxlength="120"></label>'
 +'<label>Identificador no link<input id="nsSlug" required pattern="[a-z0-9-]{3,60}" placeholder="ex.: lojadopai"></label>'
 +'<label>Nicho'+nicheSelect('nsNiche')+'</label>'
 +'<label>Câmeras contratadas<input id="nsLimit" type="number" min="1" max="128" value="1" required></label>'
 +'<p class="ct-muted">O processo inicial é criado conforme o nicho. O lojista vê apenas os processos da própria loja.</p>'
 +'<div class="ct-row-end"><button type="button" class="ct-btn ghost" id="cancelDialog">Cancelar</button><button class="ct-btn">Cadastrar loja</button></div><p class="ct-error" id="nsError" role="alert"></p></form>';
 d.showModal();
 const close=()=>d.close();el('closeDialog').onclick=close;el('cancelDialog').onclick=close;
 el('nsName').oninput=()=>{if(!el('nsSlug').dataset.touched)el('nsSlug').value=el('nsName').value.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,60)};
 el('nsSlug').oninput=()=>{el('nsSlug').dataset.touched='1'};
 el('newStoreForm').onsubmit=async e=>{e.preventDefault();try{await api('/master/tenants','POST',{name:el('nsName').value.trim(),slug:el('nsSlug').value.trim(),retention_days:15,niche:el('nsNiche').value,camera_limit:Number(el('nsLimit').value)});close();msg('Loja cadastrada.');show(view)}catch(err){el('nsError').textContent=err.message}};
}
