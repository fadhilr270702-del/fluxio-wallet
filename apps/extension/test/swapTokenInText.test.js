// Tahap C (prompt 0223, owner K5) — the token-in flow's user-facing
// sentences, locked against popup.js's SOURCE (same source-reading
// pattern as unbundledNoBarePackageImports.test.js): the two step labels,
// the two-transaction Review note, the approve-stage pending text, and
// the honest halt sentences — every one of them free of hyphens and
// dashes inside the sentence (the standing UI text rule; technical names
// are not part of these strings).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const popupSource = readFileSync(path.join(__dirname, '..', 'popup', 'popup.js'), 'utf8');

const K5_SENTENCES = [
  'Step 1 of 2: Approve ',
  // 0227 (0225 K8): the three step labels when a reset leg leads.
  'Step 1 of 3: Reset approval',
  'Step 2 of 3: Approve ',
  'Step 3 of 3: Swap',
  'This swap sends three transactions: a reset, an approval and the swap.',
  'The approval was not sent. Start again from the Swap screen.',
  'Waiting for the reset to confirm',
  'Swap is available on Solana, Ethereum, BNB Chain and Base.',
  'Step 2 of 2: Swap',
  'This swap sends two transactions: an approval and the swap.',
  'Your approval is taking longer than usual. It may still confirm. Check again in a moment.',
  'Quote changed after the approval. No swap was sent. Start again from the Swap screen.',
  'Approval confirmed. Swap not sent. Start again from the Swap screen.',
  'The swap continues in the background once the approval confirms. You can hide this screen.'
];

describe('popup.js — tahap C token-in texts (owner K5)', () => {
  it('every K5 sentence exists verbatim in the popup source', () => {
    for (const sentence of K5_SENTENCES) {
      expect(popupSource.includes(sentence), `missing: ${sentence}`).toBe(true);
    }
  });
  it('no K5 sentence carries a hyphen or dash inside it (standing UI rule)', () => {
    for (const sentence of K5_SENTENCES) {
      expect(/[-–—]/.test(sentence), `dash in: ${sentence}`).toBe(false);
    }
    // The approve-failed sentence is assembled around the pay symbol —
    // check its two literal halves in the source instead.
    expect(popupSource.includes('The approval failed on chain. Your ')).toBe(true);
    expect(popupSource.includes(' was not moved. Only the network fee was charged.')).toBe(true);
  });
  it('token to token keeps the coming soon note (network-free wording since 0227); token to native no longer disables Confirm unconditionally', () => {
    expect(popupSource.includes('Swapping a token to another token is coming soon.')).toBe(true);
    // The old network-naming sentence is GONE (revisi sadar 0227 K6).
    expect(popupSource.includes('Swapping from a token on BNB Chain is coming soon.')).toBe(false);
    expect(popupSource.includes("payAsset.address !== 'native' && receiveAsset.address !== 'native'")).toBe(true);
  });
});
