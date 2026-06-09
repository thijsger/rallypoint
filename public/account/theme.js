// Theme + background switcher
(function() {
  const THEMES = ['lime', 'ice', 'sunset', 'mono', 'court'];

  // ----- Theme -----
  const savedTheme = localStorage.getItem('rallypointTheme') || 'lime';
  const theme = THEMES.includes(savedTheme) ? savedTheme : 'lime';
  document.documentElement.dataset.theme = theme;

  window.setTheme = function(name) {
    if (!THEMES.includes(name)) return;
    document.documentElement.dataset.theme = name;
    localStorage.setItem('rallypointTheme', name);
  };
  window.getTheme = () => document.documentElement.dataset.theme || 'lime';
  window.THEMES_META = [
    { id: 'lime',   name: 'Neon Lime', color: '#c4ff00' },
    { id: 'ice',    name: 'Ice Blue',  color: '#00d4ff' },
    { id: 'sunset', name: 'Sunset',    color: '#ff9533' },
    { id: 'mono',   name: 'Mono',      color: '#ffffff' },
    { id: 'court',  name: 'Court',     color: '#4ade80' },
  ];

  // ----- Background -----
  // 'auto' = themed gradient default
  // 'black' = solid #000
  // 'dark' = solid #0a0d10
  // 'darker' = solid #050608
  // hex like '#ff0066' = custom solid
  function applyBg(bg) {
    const root = document.documentElement;
    if (!bg || bg === 'auto') {
      root.style.removeProperty('--user-bg');
      root.style.removeProperty('--user-bg-image');
      return;
    }
    let color = bg;
    if (bg === 'black') color = '#000000';
    else if (bg === 'dark') color = '#0a0d10';
    else if (bg === 'darker') color = '#050608';
    root.style.setProperty('--user-bg', color);
    root.style.setProperty('--user-bg-image', 'none');
  }
  window.setBg = function(bg) {
    if (bg === 'auto') localStorage.removeItem('rallypointBg');
    else localStorage.setItem('rallypointBg', bg);
    applyBg(bg);
  };
  window.getBg = () => localStorage.getItem('rallypointBg') || 'auto';
  window.BG_PRESETS = [
    { id: 'auto',   name: 'Thema-glow', color: null },
    { id: 'dark',   name: 'Donker',     color: '#0a0d10' },
    { id: 'black',  name: 'Zwart',      color: '#000000' },
    { id: 'darker', name: 'Diep',       color: '#050608' },
  ];

  applyBg(localStorage.getItem('rallypointBg'));
})();
