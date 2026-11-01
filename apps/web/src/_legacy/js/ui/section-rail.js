/**
 * Highlights the current section in the fixed side rail as the user scrolls.
 */
(function () {
  const railLinks = document.querySelectorAll('.section-rail a');
  if (!railLinks.length) return;

  const sections = Array.from(railLinks)
    .map((link) => ({
      link,
      el: document.getElementById(link.dataset.rail),
    }))
    .filter((s) => s.el);

  if (!sections.length) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const match = sections.find((s) => s.el === entry.target);
        if (!match) return;
        if (entry.isIntersecting) {
          railLinks.forEach((l) => l.classList.remove('is-active'));
          match.link.classList.add('is-active');
        }
      });
    },
    { rootMargin: '-40% 0px -50% 0px', threshold: 0 }
  );

  sections.forEach((s) => observer.observe(s.el));
})();
