/**
 * Dark / light mode toggle.
 * The initial theme is already applied by an inline script in <head>
 * (before first paint, to avoid a flash of the wrong theme).
 * This file only wires up the toggle button for switching afterwards.
 */
(function () {
  const root = document.documentElement;
  const toggle = document.getElementById('themeToggle');
  if (!toggle) return;

  toggle.addEventListener('click', function () {
    const current = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('fluxio-theme', next);
    } catch (err) {
      // Storage can fail in private browsing / restricted contexts — theme still
      // switches for this session, it just won't be remembered next visit.
    }
  });
})();
