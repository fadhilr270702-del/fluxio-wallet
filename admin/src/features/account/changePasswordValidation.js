/**
 * Pure client-side validation for the change-password form (prompt 0181) —
 * split out of AccountPage.jsx so it's unit-testable without a component
 * render, same pattern as broadcast/telegram's composeRecentCards.js.
 * Mirrors the backend's own rules (schemas/accountSchemas.js + the
 * createAdmin.js 8-char floor) plus the client-only confirm-match check —
 * the backend stays the real enforcer; this only saves a round trip.
 *
 * Returns null when valid, or one human-readable error string.
 */
export function validateChangePassword({ currentPassword, newPassword, confirmPassword }) {
  if (!currentPassword) return 'Current password is required.';
  if (!newPassword) return 'New password is required.';
  if (newPassword.length < 8) return 'New password must be at least 8 characters.';
  if (newPassword === currentPassword) return 'New password must be different from the current password.';
  if (newPassword !== confirmPassword) return 'New password and confirmation do not match.';
  return null;
}
