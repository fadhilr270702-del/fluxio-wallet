/**
 * Counts each .stat-number up from 0 to its data-count value once the
 * stat row scrolls into view. Purely decorative — the target values are
 * real, static facts (not live data), so this just makes them land with
 * a bit more energy.
 */
(function () {
  const statRow = document.querySelector('.stat-row');
  if (!statRow) return;

  const numbers = statRow.querySelectorAll('.stat-number');
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function animateCount(el) {
    const target = parseInt(el.dataset.count, 10) || 0;
    const suffix = el.dataset.suffix || '';
    if (prefersReducedMotion || target === 0) {
      el.textContent = target + suffix;
      return;
    }
    const duration = 900;
    const start = performance.now();

    function tick(now) {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(eased * target) + suffix;
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        numbers.forEach(animateCount);
        observer.disconnect();
      });
    },
    { threshold: 0.4 }
  );
  observer.observe(statRow);
})();
