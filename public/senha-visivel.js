// Botão "Mostrar" em cada campo de senha da página, para a pessoa conferir o que digitou
// (por exemplo, zero x letra O). Não mexe nos campos de PIN.
(() => {
  const css = document.createElement('style');
  css.textContent = '.sv-wrap{position:relative;display:block}'
    + '.sv-wrap>input{width:100%;padding-right:84px!important;box-sizing:border-box}'
    + '.sv-btn{position:absolute;right:6px;top:50%;transform:translateY(-50%);border:0;background:transparent;'
    + 'color:inherit;opacity:.75;font:inherit;font-size:13px;font-weight:600;cursor:pointer;padding:6px 8px;border-radius:6px}'
    + '.sv-btn:hover,.sv-btn:focus-visible{opacity:1;background:rgba(127,127,127,.15)}';
  document.head.appendChild(css);

  const enhance = input => {
    if (input.dataset.sv || input.inputMode === 'numeric') return;
    input.dataset.sv = '1';
    const wrap = document.createElement('span');
    wrap.className = 'sv-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sv-btn';
    const set = shown => {
      input.type = shown ? 'text' : 'password';
      btn.textContent = shown ? 'Ocultar' : 'Mostrar';
      btn.setAttribute('aria-label', shown ? 'Ocultar senha' : 'Mostrar senha');
      btn.setAttribute('aria-pressed', String(shown));
    };
    btn.addEventListener('click', () => { set(input.type === 'password'); input.focus(); });
    // Ao enviar o formulário, volta a esconder para o navegador oferecer salvar a senha normalmente.
    input.form?.addEventListener('submit', () => set(false), true);
    set(false);
    wrap.appendChild(btn);
  };

  const run = () => document.querySelectorAll('input[type="password"]').forEach(enhance);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
