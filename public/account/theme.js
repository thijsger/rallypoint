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
  // 'auto'   = themed gradient (default)
  // preset   = solid kleur of CSS gradient image
  // '#hex'   = custom solid kleur
  window.BG_PRESETS = [
    { id: 'auto',     name: 'Thema',    color: null,       image: null,
      preview: 'radial-gradient(circle at 30% 30%, var(--ball), transparent 70%), #0a0d10' },
    { id: 'dark',     name: 'Donker',   color: '#0a0d10' },
    { id: 'black',    name: 'Zwart',    color: '#000000' },
    { id: 'darker',   name: 'Diep',     color: '#050608' },
    { id: 'midnight', name: 'Midnight', color: '#0c1929',
      image: 'linear-gradient(135deg, #0c1929 0%, #050608 100%)' },
    { id: 'cosmic',   name: 'Cosmic',   color: '#1a0d2e',
      image: 'linear-gradient(135deg, #1a0d2e 0%, #050608 100%)' },
    { id: 'dawn',     name: 'Dawn',     color: '#2d1810',
      image: 'linear-gradient(180deg, #2d1810 0%, #0a0d10 60%)' },
    { id: 'ocean',    name: 'Ocean',    color: '#0a2a35',
      image: 'linear-gradient(180deg, #0a2a35 0%, #050608 80%)' },
  ];

  function applyBg(bg) {
    const root = document.documentElement;
    if (!bg || bg === 'auto') {
      root.style.removeProperty('--user-bg');
      root.style.removeProperty('--user-bg-image');
      return;
    }
    const preset = window.BG_PRESETS.find(p => p.id === bg);
    if (preset) {
      if (preset.color) root.style.setProperty('--user-bg', preset.color);
      else root.style.removeProperty('--user-bg');
      root.style.setProperty('--user-bg-image', preset.image || 'none');
    } else if (bg.startsWith('#')) {
      // Custom hex
      root.style.setProperty('--user-bg', bg);
      root.style.setProperty('--user-bg-image', 'none');
    }
  }
  window.setBg = function(bg) {
    if (bg === 'auto') localStorage.removeItem('rallypointBg');
    else localStorage.setItem('rallypointBg', bg);
    applyBg(bg);
  };
  window.getBg = () => localStorage.getItem('rallypointBg') || 'auto';

  applyBg(localStorage.getItem('rallypointBg'));
})();
