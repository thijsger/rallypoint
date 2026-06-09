// Toast helper — gebruik window.toast(msg, type) waar type ∈ 'info'|'success'|'err'
(function() {
  function ensureContainer() {
    let c = document.getElementById('toast-container');
    if (c) return c;
    c = document.createElement('div');
    c.id = 'toast-container';
    c.className = 'toast-container';
    document.body.appendChild(c);
    return c;
  }
  window.toast = function(message, type = 'info', durationMs = 3500) {
    const c = ensureContainer();
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
})();
