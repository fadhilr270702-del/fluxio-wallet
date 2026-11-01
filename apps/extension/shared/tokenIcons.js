/**
 * Embedded token icons (prompt 0206, owner decision: LOGO DITANAM — the
 * extension NEVER loads an image from the network; every icon below is a
 * bundled 96x96 PNG under apps/extension/assets/tokens/).
 *
 * Lookup is BY MINT ADDRESS, never by symbol: a scam token reusing the
 * symbol "USDT" on a different mint gets NO icon from here — the popup
 * falls back to the same colored-letter placeholder every unlisted token
 * has always had. The mints below are the owner-approved FINAL set of 23
 * (20 September 2026, two contact-sheet reviews: 13 kept from the
 * volume-ranked sheet, 5 approved candidates, 5 owner additions; see
 * docs/release/token-icons-sources.md for each file's source URL,
 * download date, and sha256).
 *
 * Native SOL is deliberately absent — the chain logo
 * (assets/chains/solana.png) already covers it everywhere.
 */

/** mint -> bundled file name (all under assets/tokens/). Frozen so a
 * runtime write can never redirect an icon. */
export const TOKEN_ICON_FILES = Object.freeze({
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.png', // USDC
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB.png', // USDT
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij.png', // cbBTC
  A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS: 'A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS.png', // ZEC
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs.png', // ETH (Portal)
  '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g': '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g.png', // HYPE
  USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB.png', // USD1
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH': '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH.png', // USDG
  pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn: 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn.png', // PUMP
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R.png', // RAY
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo.png', // PYUSD
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh.png', // WBTC (Portal)
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN.png', // JUP
  // Second owner review, 20 September 2026: 5 approved candidates
  // (holderCount-ranked, organicScore label high) ...
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263.png', // Bonk
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm.png', // $WIF (dogwifhat)
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL.png', // JTO
  CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH: 'CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH.png', // CASH
  '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv': '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv.png', // PENGU
  // ... plus 5 owner-decided additions OVERRIDING the screening filters
  // (widely held established projects; rationale in
  // docs/release/token-icons-sources.md).
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn.png', // JitoSOL
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So.png', // mSOL
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3.png', // PYTH
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE.png', // ORCA
  rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof.png' // RENDER
});

/**
 * Address aliases (prompt 0214): a non-Solana address that reuses an
 * already-embedded PNG, keyed by NORMALIZED (lowercase) EVM address and
 * pointing at the canonical mint key in TOKEN_ICON_FILES. Kept as a
 * separate map so TOKEN_ICON_FILES keeps its "every key is a mint whose
 * file is <mint>.png on disk" invariant (locked by
 * test/tokenIcons.test.js) untouched. Four current entries, zero new
 * image files for all of them: USDT on BNB Chain (Binance-Peg BSC-USD,
 * prompt 0214) and USDT on Ethereum (0227) both reuse the Solana USDT
 * PNG; USDC on Ethereum and USDC on Base (0230) both reuse the Solana
 * USDC PNG — same token identity for the user either way.
 */
export const TOKEN_ICON_ALIASES = Object.freeze({
  '0x55d398326f99059ff775485246999027b3197955': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT (BEP20) -> USDT (Solana) PNG
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT (Ethereum, 0227) -> same USDT PNG, zero new image files
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC (Ethereum, 0230) -> USDC (Solana) PNG, zero new image files
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC (Base, 0230) -> same USDC PNG, zero new image files
});

/**
 * Relative src (from a page in a popup/-level folder, e.g.
 * popup/popup.html) for a mint's bundled icon, or null when the mint has
 * no embedded icon — the caller then renders the colored-letter
 * placeholder, exactly as before this feature. Only ever returns a local
 * ../assets/ path; never a URL. An EVM address (0x…) is lowercased
 * before lookup (EVM addresses compare case-insensitively — the
 * registry's own normalizeTokenAddress rule) and may resolve through
 * TOKEN_ICON_ALIASES to a canonical mint; Solana mints stay
 * case-sensitive exact keys, as before.
 */
export function tokenIconSrc(mint) {
  let key = typeof mint === 'string' && mint.startsWith('0x') ? mint.toLowerCase() : mint;
  key = TOKEN_ICON_ALIASES[key] || key;
  const file = TOKEN_ICON_FILES[key];
  return file ? `../assets/tokens/${file}` : null;
}
