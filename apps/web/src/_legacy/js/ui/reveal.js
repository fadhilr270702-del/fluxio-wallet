/**
 * Scroll-triggered fade/slide-in for any element marked .reveal-up.
 */
(function () {
  const items = document.querySelectorAll('.reveal-up');
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!items.length) return;

  if (prefersReducedMotion) {
    items.forEach((el) => el.classList.add('in-view'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in-view');
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
  );

  items.forEach((el, index) => {
    el.style.transitionDelay = `${(index % 4) * 70}ms`;
    observer.observe(el);
  });
})();
