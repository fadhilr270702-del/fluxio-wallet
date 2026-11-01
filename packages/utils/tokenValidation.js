/**
 * Server-side (background.js) validation for the "Add custom token" flow
 * — deliberately real, decode-based checks rather than the looser
 * charset/length regex apps/extension/popup/popup.js's own
 * looksLikeAddress() uses for live-typing UI feedback. That heuristic is
 * fine for "does this look plausible while the user is still typing";
 * this is the authoritative check that actually decides whether a token
 * gets persisted to chrome.storage.local, so it verifies structure for
 * real (an EVM address is checked to actually decode as 20 bytes of hex;
 * a Solana address is base58-decoded and checked to actually be 32
 * bytes, not just "looks like base58 charset at a plausible length").
 */
import bs58 from 'bs58';

/** A syntactically valid EVM address: "0x" + exactly 40 hex characters (20 bytes). Does not require/verify EIP-55 checksum casing — an all-lowercase address is just as structurally valid as a correctly-checksummed one. */
export function isValidEvmAddress(address) {
  return typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address);
}

/** A syntactically valid Solana address: valid base58 that decodes to exactly 32 bytes (an ed25519 public key's length — what every Solana account/mint address is). Rejects anything that merely *looks* like base58 (right charset, plausible length) but doesn't actually decode to 32 bytes. */
export function isValidSolanaAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false;
  try {
    const decoded = bs58.decode(address);
    return decoded.length === 32;
  } catch {
    return false;
  }
}

/** An integer 0..18 inclusive — the range every ERC-20 in practice actually uses (uint8 could technically go to 255, but a token with, say, 200 decimals isn't meaningfully representable/useful, and every real token in the wild is well under 18). Used only for a manually-entered EVM decimals override; Solana's decimals always comes from the chain, never manual input (see tokenService.js's fetchSolanaMintInfo()). */
export function isValidTokenDecimals(value) {
  return Number.isInteger(value) && value >= 0 && value <= 18;
}
