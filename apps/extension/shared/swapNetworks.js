/**
 * EVM swap network list + the popup's per-network fee reserves (prompt
 * 0227, owner keputusan 0225 K1/K3).
 *
 * WHY THIS FILE EXISTS: popup.js is unbundled plain JS and structurally
 * cannot import @fluxio/* packages (the standing messaging rule), but it
 * still needs to know WHICH networks route into the EVM swap screen and
 * how much native coin to reserve per network. The authoritative list
 * lives in @fluxio/services/evmSwapService.js (EVM_SWAP_NETWORK_KEYS,
 * derived from KYBER_CHAIN_SLUGS); this copy is locked EQUAL to it by a
 * unit test (test/swapNetworks.test.js) so the two can never drift —
 * chosen over piping the list through a GET_SWAP_TOKENS response because
 * the popup needs it BEFORE any background round trip (the network
 * picker's own dispatch).
 *
 * Reserves (0225 K3, owner final): screen-side STATIC ceilings for the
 * MAX button and the Review balance gate — the authoritative checks stay
 * server side with LIVE figures (EXECUTE pagar e, the approve legs' own
 * combined ceiling checks). Measured basis, 0225 bukti 7: a BNB swap's
 * real max fee is ~1,7e13 wei (0,05 gwei flat); an Ethereum swap's
 * ceiling measured 8,25e13 wei at 0,12 gwei with base fee swinging to
 * 0,26 gwei within hours (0226), hence the wide 4e14; Base measured
 * ~6e12 wei at a stable 0,011 gwei. tokenIn covers up to THREE
 * transactions since 0227 (reset + approve + swap — 0225 K8).
 */
export const EVM_SWAP_NETWORK_KEYS = Object.freeze(['bnb', 'ethereum', 'base']);

/** Per-network {native, tokenIn} reserves in wei (0225 K3). `native` backs the native MAX button and the native-pay Review gate; `tokenIn` is the native gas a token pay must additionally hold. */
export const SWAP_EVM_FEE_RESERVES_WEI = Object.freeze({
  bnb: Object.freeze({ native: 40000000000000n, tokenIn: 80000000000000n }), // 0,00004 / 0,00008 BNB (0220/0223, unchanged)
  ethereum: Object.freeze({ native: 400000000000000n, tokenIn: 600000000000000n }), // 0,0004 / 0,0006 ETH
  base: Object.freeze({ native: 20000000000000n, tokenIn: 40000000000000n }) // 0,00002 / 0,00004 ETH
});

/** @returns {boolean} true when `key` routes into the EVM swap screen. */
export function isEvmSwapNetworkKey(key) {
  return EVM_SWAP_NETWORK_KEYS.includes(key);
}

/** The swap screens' one normalization rule (0225 K1): an EVM swap network keeps its own key, everything else is the Solana screen. */
export function normalizeSwapNetworkKey(key) {
  return isEvmSwapNetworkKey(key) ? key : 'solana';
}
