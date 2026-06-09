// Theme + background flash-prevention script.
// Runs synchronously before first paint — must stay dependency-free.
(function () {
  var THEMES = ['lime', 'ice', 'sunset', 'mono', 'court'];
  var t = localStorage.getItem('rallypointTheme') || 'lime';
  document.documentElement.dataset.theme = THEMES.indexOf(t) >= 0 ? t : 'lime';

  // Solid background color per preset-id
  var COLORS = {
    pewter: '#3a414c', slate: '#2a3038', steel: '#1f2630',
    dark: '#0a0d10', darker: '#050608', black: '#000000',
    midnight: '#163556', cosmic: '#33184f', dawn: '#4a2812',
    ocean: '#0d4358', forest: '#15402c', glow: '#1a1f28'
  };
  // Optional gradient overlay per preset-id (layered on top of the solid color)
  // Note: var(--ball-glow) / var(--ball-soft) resolve at paint time after the
  // stylesheet loads, so the CSS variables are theme-aware even in this script.
  var IMAGES = {
    glow:     'radial-gradient(ellipse 70% 60% at 50% 0%,var(--ball-glow),transparent 60%),radial-gradient(ellipse 80% 50% at 50% 100%,var(--ball-soft),transparent 60%),#1a1f28',
    midnight: 'linear-gradient(135deg,#163556 0%,#0a1828 100%)',
    cosmic:   'linear-gradient(135deg,#33184f 0%,#1a0d2a 100%)',
    dawn:     'linear-gradient(180deg,#4a2812 0%,#1a0e08 70%)',
    ocean:    'linear-gradient(180deg,#0d4358 0%,#061e26 80%)',
    forest:   'linear-gradient(180deg,#15402c 0%,#081a12 80%)'
  };

  var b = localStorage.getItem('rallypointBg');
  var d = document.documentElement;
  if (!b || b === 'auto') return;

  if (COLORS[b]) {
    d.style.setProperty('--user-bg', COLORS[b]);
    d.style.setProperty('--user-bg-image', IMAGES[b] || 'none');
  } else if (b.charAt(0) === '#') {
    d.style.setProperty('--user-bg', b);
    d.style.setProperty('--user-bg-image', 'none');
  }
  // Unknown preset-id: do nothing — default dark bg remains
})();
