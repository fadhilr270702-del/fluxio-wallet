/**
 * Fluxio landing page
 * No backend is wired up yet — this validates input and gives the user
 * clear feedback. Swap the TODO section for a real API call later
 * (e.g. packages/services/waitlistService.js once that exists).
 */
(function () {
  const form = document.getElementById('waitlistForm');
  const emailInput = document.getElementById('email');
  const message = document.getElementById('waitlistMessage');

  if (!form) return;

  function isValidEmail(value) {
    // Simple, permissive check — real validation happens server-side later.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    const email = emailInput.value.trim();

    if (!isValidEmail(email)) {
      showMessage(message, 'That email doesn\u2019t look right \u2014 double-check it and try again.');
      emailInput.focus();
      return;
    }

    // TODO: replace with a real request once the waitlist backend exists.
    // Example:
    // await fetch('/api/waitlist', { method: 'POST', body: JSON.stringify({ email }) });

    showMessage(message, `You're on the list. We'll email ${email} when Fluxio opens up.`, { duration: 6000 });
    form.reset();
  });
})();
