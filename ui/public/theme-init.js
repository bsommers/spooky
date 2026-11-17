/* Runs before first paint (same-origin classic script, so the CSP needs no inline allowance): sets data-theme and the
   reduced-motion marker so the page never flashes the wrong theme. Mirrors src/theme/engine.ts (a test runs both and
   compares). Theme ids come from <html data-themes>, written into index.html at build time from src/theme/manifest.ts. */
(function () {
  var root = document.documentElement;
  var themes = [];
  try {
    themes = JSON.parse(root.getAttribute('data-themes') || '[]');
  } catch (e) {
    themes = [];
  }
  if (!themes.length) return;
  var fallback = root.getAttribute('data-default-theme') || themes[0].id;
  var id = null;
  try {
    var stored = window.localStorage.getItem('gw-theme');
    for (var i = 0; i < themes.length; i++) if (themes[i].id === stored) id = stored;
  } catch (e) {
    /* blocked storage: fall through to the system preference */
  }
  var mm = typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null;
  function matches(q) {
    try {
      return !!mm && mm(q).matches;
    } catch (e) {
      return false;
    }
  }
  if (!id) {
    var scheme = !matches('(prefers-color-scheme: dark)') && matches('(prefers-color-scheme: light)') ? 'light' : 'dark';
    id = fallback;
    for (var j = 0; j < themes.length; j++) {
      if (themes[j].colorScheme === scheme) {
        id = themes[j].id;
        break;
      }
    }
  }
  root.setAttribute('data-theme', id);
  for (var k = 0; k < themes.length; k++) if (themes[k].id === id) root.style.colorScheme = themes[k].colorScheme;
  if (matches('(prefers-reduced-motion: reduce)')) {
    root.setAttribute('data-motion', 'reduced');
    root.style.setProperty('--gw-motion-scale', '0');
  }
})();
