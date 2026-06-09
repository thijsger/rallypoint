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
      preview: 'radial-gradient(circle at 30% 30%, var(--ball), transparent 70%), #181d24' },
    // Light → dark (zodat lichtere opties bovenaan staan)
    { id: 'pewter',   name: 'Pewter',   color: '#3a414c' },
    { id: 'slate',    name: 'Slate',    color: '#2a3038' },
    { id: 'steel',    name: 'Steel',    color: '#1f2630' },
    { id: 'glow',     name: 'Glow',     color: '#1a1f28',
      image: 'radial-gradient(ellipse 70% 60% at 50% 0%, var(--ball-glow), transparent 60%), radial-gradient(ellipse 80% 50% at 50% 100%, var(--ball-soft), transparent 60%), #1a1f28' },
    { id: 'dark',     name: 'Donker',   color: '#0a0d10' },
    { id: 'darker',   name: 'Diep',     color: '#050608' },
    { id: 'black',    name: 'Zwart',    color: '#000000' },
    { id: 'midnight', name: 'Midnight', color: '#163556',
      image: 'linear-gradient(135deg, #163556 0%, #0a1828 100%)' },
    { id: 'cosmic',   name: 'Cosmic',   color: '#33184f',
      image: 'linear-gradient(135deg, #33184f 0%, #1a0d2a 100%)' },
    { id: 'dawn',     name: 'Dawn',     color: '#4a2812',
      image: 'linear-gradient(180deg, #4a2812 0%, #1a0e08 70%)' },
    { id: 'ocean',    name: 'Ocean',    color: '#0d4358',
      image: 'linear-gradient(180deg, #0d4358 0%, #061e26 80%)' },
    { id: 'forest',   name: 'Forest',   color: '#15402c',
      image: 'linear-gradient(180deg, #15402c 0%, #081a12 80%)' },
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
