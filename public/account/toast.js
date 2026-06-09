// Shared UI helpers: toast(), confirm(), button loading
(function() {
  function ensureToastContainer() {
    let c = document.getElementById('toast-container');
    if (c) return c;
    c = document.createElement('div');
    c.id = 'toast-container';
    c.className = 'toast-container';
    document.body.appendChild(c);
    return c;
  }

  window.toast = function(message, type = 'info', durationMs = 3500) {
    const c = ensureToastContainer();
    const t = document.createElement('div');
    t.className = 'toast toast-' + type;
    t.textContent = message;
    c.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, durationMs);
  };

  // window.confirmModal({title, body, confirmLabel, danger}) → Promise<boolean>
  window.confirmModal = function(opts) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const cls = opts.danger ? 'danger' : '';
      overlay.innerHTML = `
        <div class="modal-card" role="dialog" aria-modal="true">
          <h3>${opts.title || 'Weet je het zeker?'}</h3>
          <p>${opts.body || ''}</p>
          <div class="modal-actions">
            <button class="btn secondary" data-action="cancel">${opts.cancelLabel || 'Annuleren'}</button>
            <button class="btn ${cls}" data-action="ok">${opts.confirmLabel || 'OK'}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('show'));
      function close(result) {
        overlay.classList.remove('show');
        setTimeout(() => { overlay.remove(); resolve(result); }, 200);
      }
      overlay.addEventListener('click', e => {
        if (e.target === overlay) close(false);
        const action = e.target.closest('button')?.dataset.action;
        if (action === 'ok') close(true);
        if (action === 'cancel') close(false);
      });
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { close(false); document.removeEventListener('keydown', esc); }
      });
    });
  };

  // Markeer een knop als 'loading' (toont spinner, blokkeert clicks).
  window.btnLoading = function(btn, on = true) {
    if (!btn) return;
    if (on) { btn.dataset.loading = '1'; btn.disabled = true; }
    else { delete btn.dataset.loading; btn.disabled = false; }
  };
})();
