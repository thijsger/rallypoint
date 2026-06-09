// Theme switcher — laad opgeslagen theme bij elke page load
(function() {
  const THEMES = ['lime', 'ice', 'sunset', 'mono', 'court'];
  const saved = localStorage.getItem('rallypointTheme') || 'lime';
  const theme = THEMES.includes(saved) ? saved : 'lime';
  document.documentElement.dataset.theme = theme;

  window.setTheme = function(name) {
    if (!THEMES.includes(name)) return;
    document.documentElement.dataset.theme = name;
    localStorage.setItem('rallypointTheme', name);
  };
  window.getTheme = () => document.documentElement.dataset.theme || 'lime';
  window.THEMES_META = [
    { id: 'lime',    name: 'Neon Lime', color: '#c4ff00' },
    { id: 'ice',     name: 'Ice Blue',  color: '#00d4ff' },
    { id: 'sunset',  name: 'Sunset',    color: '#ff9533' },
    { id: 'mono',    name: 'Mono',      color: '#ffffff' },
    { id: 'court',   name: 'Court',     color: '#4ade80' },
  ];
})();
