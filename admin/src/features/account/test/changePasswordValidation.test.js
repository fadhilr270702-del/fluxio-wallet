/**
 * Prompt 0181 — unit tests for the change-password form's pure client-side
 * validation (the component itself stays untested, matching this admin
 * package's own convention: only pure, extracted helpers get unit tests —
 * see composeRecentCards.test.js, the pattern this follows).
 */
import { describe, it, expect } from 'vitest';
import { validateChangePassword } from '../changePasswordValidation.js';

const valid = {
  currentPassword: 'old-password-1',
  newPassword: 'new-password-1',
  confirmPassword: 'new-password-1',
};

describe('validateChangePassword()', () => {
  it('accepts a fully valid input', () => {
    expect(validateChangePassword(valid)).toBeNull();
  });

  it('requires the current password', () => {
    expect(validateChangePassword({ ...valid, currentPassword: '' })).toBe('Current password is required.');
  });

  it('requires the new password', () => {
    expect(validateChangePassword({ ...valid, newPassword: '', confirmPassword: '' })).toBe('New password is required.');
  });

  it('rejects a new password shorter than 8 characters', () => {
    expect(validateChangePassword({ ...valid, newPassword: 'short7!', confirmPassword: 'short7!' })).toBe(
      'New password must be at least 8 characters.'
    );
  });

  it('rejects a new password identical to the current one', () => {
    expect(
      validateChangePassword({
        currentPassword: 'same-password',
        newPassword: 'same-password',
        confirmPassword: 'same-password',
      })
    ).toBe('New password must be different from the current password.');
  });

  it('rejects a confirmation that does not match', () => {
    expect(validateChangePassword({ ...valid, confirmPassword: 'different-password' })).toBe(
      'New password and confirmation do not match.'
    );
  });
});
