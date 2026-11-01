/**
 * Prompt 0207 — locks the DEFAULT Welcome text (the repo fallback; the
 * live Welcome is owner-managed via the admin panel and wins whenever
 * configured). Two guarantees:
 *   1. The exact owner-approved wording (W1) — a silent edit fails here.
 *   2. The owner's public-text rules hold structurally: no "forever",
 *      no "Free transfers", no "-" inside the text, no "&", and no
 *      em/en dashes.
 */
import { describe, it, expect } from 'vitest';
import { WELCOME_MESSAGE_TEXT } from '../welcome.js';

describe('default Welcome text (repo fallback, prompt 0207)', () => {
  it('is exactly the owner-approved W1 wording', () => {
    expect(WELCOME_MESSAGE_TEXT).toBe(
      'Welcome to Fluxio Wallet!\n\n' +
        'Non custodial crypto wallet for Solana and EVM. Fluxio adds no fee on transfers. You only pay the network fee, nothing extra to us.\n\n' +
        "You're now subscribed to official announcements and updates."
    );
  });

  it('carries none of the banned strings or characters', () => {
    expect(WELCOME_MESSAGE_TEXT).not.toMatch(/forever/i);
    expect(WELCOME_MESSAGE_TEXT).not.toMatch(/Free transfers/i);
    expect(WELCOME_MESSAGE_TEXT).not.toContain('-');
    expect(WELCOME_MESSAGE_TEXT).not.toContain('&');
    expect(WELCOME_MESSAGE_TEXT).not.toMatch(/[–—]/);
  });
});
