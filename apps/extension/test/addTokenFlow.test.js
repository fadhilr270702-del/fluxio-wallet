import { describe, it, expect } from 'vitest';
import { isDecimalsEditable, canOfferManualFallback, LOOKUP_STATUS } from '../shared/addTokenFlow.js';

describe('isDecimalsEditable', () => {
  it('is NEVER editable for Solana, even when fetchedDecimals is missing (RPC down) — the one hard invariant this file exists to protect', () => {
    expect(isDecimalsEditable({ isEvm: false, fetchedDecimals: null })).toBe(false);
    expect(isDecimalsEditable({ isEvm: false, fetchedDecimals: undefined })).toBe(false);
  });

  it('is NEVER editable for Solana even if a caller mistakenly passes a resolved decimals value', () => {
    // Defensive case: this should never happen in practice (Solana's
    // preview handler never returns a non-null fetchedDecimals for
    // anything but a genuine mint read), but the rule must hold
    // regardless of what fetchedDecimals says — Solana decimals is
    // simply never a user-editable concept.
    expect(isDecimalsEditable({ isEvm: false, fetchedDecimals: 6 })).toBe(false);
  });

  it('is NOT editable for EVM when metadata resolution successfully returned a decimals value', () => {
    expect(isDecimalsEditable({ isEvm: true, fetchedDecimals: 18 })).toBe(false);
    expect(isDecimalsEditable({ isEvm: true, fetchedDecimals: 0 })).toBe(false); // 0 is a valid, falsy-but-present decimals value
  });

  it('IS editable for EVM when metadata resolution could not determine decimals', () => {
    expect(isDecimalsEditable({ isEvm: true, fetchedDecimals: null })).toBe(true);
    expect(isDecimalsEditable({ isEvm: true, fetchedDecimals: undefined })).toBe(true);
  });
});

describe('canOfferManualFallback', () => {
  it('offers a manual fallback for EVM (a real, routine case — local anvil restarts)', () => {
    expect(canOfferManualFallback({ isEvm: true })).toBe(true);
  });

  it('never offers a manual fallback for Solana — decimals is fundamentally unknowable without a real mint read', () => {
    expect(canOfferManualFallback({ isEvm: false })).toBe(false);
  });
});

describe('LOOKUP_STATUS', () => {
  it('exposes exactly the 6 states the form logic reasons about', () => {
    expect(Object.values(LOOKUP_STATUS).sort()).toEqual(
      ['address', 'found', 'looking-up', 'manual', 'not-found', 'rpc-unreachable'].sort()
    );
  });
});
