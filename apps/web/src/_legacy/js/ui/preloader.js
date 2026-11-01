/**
 * Decorative loading screen. The progress shown is a timed animation
 * (not literal byte-for-byte asset progress) — a common, honest pattern
 * for lightweight sites where real load time is near-instant but a
 * loader is still wanted for the entrance feel.
 */
(function () {
  const overlay = document.getElementById('preloader');
  const fill = document.getElementById('preloaderFill');
  const pct = document.getElementById('preloaderPct');
  if (!overlay) return;

  document.body.classList.add('is-loading');

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DURATION = prefersReducedMotion ? 150 : 1500;
  const start = performance.now();

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function tick(now) {
    const elapsed = now - start;
    const progress = Math.min(1, elapsed / DURATION);
    const eased = easeOutCubic(progress);
    const displayed = Math.round(eased * 100);

    if (fill) fill.style.width = displayed + '%';
    if (pct) pct.textContent = displayed + '%';

    if (progress < 1) {
      requestAnimationFrame(tick);
    } else {
      finish();
    }
  }

  function finish() {
    overlay.classList.add('hidden');
    document.body.classList.remove('is-loading');
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
    // Fallback in case transitionend doesn't fire (e.g. display:none edge cases)
    setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 900);
  }

  requestAnimationFrame(tick);
})();
