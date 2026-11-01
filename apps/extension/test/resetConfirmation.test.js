import { describe, it, expect } from 'vitest';
import { RESET_CONFIRMATION_PHRASE, isResetConfirmationValid } from '../shared/resetConfirmation.js';

describe('isResetConfirmationValid — prompt 0124 "type RESET to confirm" gate', () => {
  it('accepts the exact phrase', () => {
    expect(isResetConfirmationValid('RESET')).toBe(true);
    expect(RESET_CONFIRMATION_PHRASE).toBe('RESET');
  });

  it('rejects wrong case', () => {
    expect(isResetConfirmationValid('reset')).toBe(false);
    expect(isResetConfirmationValid('Reset')).toBe(false);
    expect(isResetConfirmationValid('rEsEt')).toBe(false);
  });

  it('rejects surrounding whitespace — "persis" means exact, no trimming', () => {
    expect(isResetConfirmationValid('RESET ')).toBe(false);
    expect(isResetConfirmationValid(' RESET')).toBe(false);
    expect(isResetConfirmationValid(' RESET ')).toBe(false);
    expect(isResetConfirmationValid('RESET\n')).toBe(false);
  });

  it('rejects a prefix or suffix of the real phrase', () => {
    expect(isResetConfirmationValid('RESE')).toBe(false);
    expect(isResetConfirmationValid('RESETT')).toBe(false);
    expect(isResetConfirmationValid('RESET!')).toBe(false);
  });

  it('rejects the empty string and other falsy/typed-nothing states', () => {
    expect(isResetConfirmationValid('')).toBe(false);
    expect(isResetConfirmationValid(undefined)).toBe(false);
    expect(isResetConfirmationValid(null)).toBe(false);
  });

  it('rejects non-string values, never throwing', () => {
    expect(isResetConfirmationValid(123)).toBe(false);
    expect(isResetConfirmationValid({})).toBe(false);
    expect(isResetConfirmationValid(['RESET'])).toBe(false);
  });

  it('rejects a plausible-looking but wrong word', () => {
    expect(isResetConfirmationValid('DELETE')).toBe(false);
    expect(isResetConfirmationValid('CONFIRM')).toBe(false);
  });
});
