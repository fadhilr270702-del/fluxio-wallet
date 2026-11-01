/**
 * Subtle 3D tilt on hover for bento tiles — the cursor position within
 * a tile drives a small rotateX/rotateY. Skipped entirely on touch
 * devices (no meaningful hover) and when the user prefers reduced motion.
 */
(function () {
  const tiles = document.querySelectorAll('.tile');
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const noHover = window.matchMedia('(hover: none)').matches;

  if (!tiles.length || prefersReducedMotion || noHover) return;

  const MAX_TILT_DEG = 4.5;

  tiles.forEach((tile) => {
    tile.addEventListener('mousemove', (event) => {
      if (!tile.classList.contains('in-view')) return;
      const rect = tile.getBoundingClientRect();
      const relX = (event.clientX - rect.left) / rect.width - 0.5;
      const relY = (event.clientY - rect.top) / rect.height - 0.5;

      const rotateY = relX * MAX_TILT_DEG * 2;
      const rotateX = -relY * MAX_TILT_DEG * 2;

      tile.style.transform =
        `translateY(0) perspective(800px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg)`;
    });

    tile.addEventListener('mouseleave', () => {
      if (!tile.classList.contains('in-view')) return;
      tile.style.transform = 'translateY(0) perspective(800px) rotateX(0deg) rotateY(0deg)';
    });
  });
})();
