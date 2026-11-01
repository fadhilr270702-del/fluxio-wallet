import { describe, it, expect } from 'vitest';
import { resolveCardBackground, CARD_BACKGROUND_ACCENT, CARD_BACKGROUND_PLAIN, CARD_BACKGROUND_OPTIONS } from '../shared/cardBackground.js';

describe('resolveCardBackground — prompt 0121 default resolution', () => {
  it('resolves the literal "plain" string to CARD_BACKGROUND_PLAIN', () => {
    expect(resolveCardBackground('plain')).toBe(CARD_BACKGROUND_PLAIN);
  });

  it('resolves the literal "accent" string to CARD_BACKGROUND_ACCENT', () => {
    expect(resolveCardBackground('accent')).toBe(CARD_BACKGROUND_ACCENT);
  });

  it('defaults to CARD_BACKGROUND_ACCENT when unset (undefined) — a fresh install with no stored value yet', () => {
    expect(resolveCardBackground(undefined)).toBe(CARD_BACKGROUND_ACCENT);
  });

  it('defaults to CARD_BACKGROUND_ACCENT for null', () => {
    expect(resolveCardBackground(null)).toBe(CARD_BACKGROUND_ACCENT);
  });

  it('fails toward CARD_BACKGROUND_ACCENT for an unrecognized/corrupt string, not toward plain', () => {
    expect(resolveCardBackground('typo-value')).toBe(CARD_BACKGROUND_ACCENT);
  });

  it('fails toward CARD_BACKGROUND_ACCENT for a wrong-type stored value (number/object), never throwing', () => {
    expect(resolveCardBackground(1)).toBe(CARD_BACKGROUND_ACCENT);
    expect(resolveCardBackground({})).toBe(CARD_BACKGROUND_ACCENT);
  });

  it('CARD_BACKGROUND_OPTIONS lists exactly the two real values, in display order', () => {
    expect(CARD_BACKGROUND_OPTIONS.map((o) => o.value)).toEqual([CARD_BACKGROUND_ACCENT, CARD_BACKGROUND_PLAIN]);
  });
});
