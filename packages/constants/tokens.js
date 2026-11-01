/**
 * Per-network token registry — SPL mints (Solana) and ERC-20 contract
 * addresses (EVM), used by @fluxio/services/tokenService.js. Mirrors
 * networks.js's own "no secrets, only public config" rule: every address
 * here is public information.
 *
 * Every entry below was verified against developers.circle.com's official
 * "USDC Contract Addresses" reference page before being hardcoded — not
 * copied from an unverified source. Where verification wasn't possible,
 * the network is left empty rather than guessing (see solana-local/
 * ethereum-local below, and the BNB Chain comment).
 *
 * Entry shape: { symbol, name, decimals, address }
 *   - `address` is a mint address for a Solana entry, a contract address
 *     for an EVM entry.
 *   - `decimals` here is only ever used for an EVM entry (no on-chain way
 *     to ask an arbitrary ERC-20 contract for its decimals without an
 *     extra eth_call per token — ...actually tokenService.js *does* still
 *     make exactly one eth_call per registry token already, for
 *     balanceOf; a second one for decimals() was deliberately skipped to
 *     avoid doubling the RPC calls for a value that's effectively static
 *     per contract, so it's declared here instead). A *Solana* entry's
 *     `decimals` value is never read — tokenService.js always takes SPL
 *     decimals from the getTokenAccountsByOwner response itself
 *     (tokenAmount.decimals), which is authoritative and per-account, so
 *     duplicating it here would be redundant at best and stale at worst.
 */
import { NETWORK_KEYS, NETWORKS } from './networks.js';
import { ACCOUNT_TYPES } from './derivationPaths.js';

export const TOKENS = Object.freeze({
  // Circle's official Solana Devnet USDC mint — verified via
  // https://developers.circle.com/stablecoins/usdc-contract-addresses
  // (Testnet section). NOTE: this is NOT the address originally suggested
  // for this slice (Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr) — that
  // address could not be verified against Circle's docs and does not
  // match the officially published one, so it was not used.
  [NETWORK_KEYS.SOLANA_DEVNET]: Object.freeze([
    Object.freeze({
      symbol: 'USDC',
      name: 'USD Coin (Devnet)',
      decimals: 6,
      address: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
    })
  ]),
  // Circle's official Ethereum Sepolia USDC contract — verified the same
  // way as the Devnet entry above.
  [NETWORK_KEYS.ETHEREUM_SEPOLIA]: Object.freeze([
    Object.freeze({
      symbol: 'USDC',
      name: 'USD Coin (Sepolia)',
      decimals: 6,
      address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
    })
  ]),
  // Local dev nodes: a mint/deploy address here is only ever whatever a
  // developer's own solana-test-validator/anvil instance produced on this
  // run of scripts/spl-token-demo.mjs / scripts/erc20-local-demo.mjs — it
  // changes every time, so there is nothing valid to hardcode. Populated
  // only via the chrome.storage.local custom-token override (see
  // mergeTokens() below); both demo scripts print a ready-to-paste
  // registration snippet for exactly this purpose.
  [NETWORK_KEYS.SOLANA_LOCAL]: Object.freeze([]),
  [NETWORK_KEYS.ETHEREUM_LOCAL]: Object.freeze([]),
  // Mainnet — well-known Circle-issued USDC addresses, also verified
  // against developers.circle.com. Included for completeness (the popup
  // shows a mainnet network's rows regardless of this file), but this
  // slice does no extra work to surface them beyond that — no dedicated
  // mainnet UI, no different treatment from a testnet entry.
  [NETWORK_KEYS.SOLANA]: Object.freeze([
    Object.freeze({
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    }),
    // USDT (prompt 0206) — mint verified against Tether's OWN integration
    // page (tether.to, supported protocols): "To integrate Tether's
    // Solana Token on the Solana Blockchain use the USD₮ contract
    // address: Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB". Added after
    // the 0205 real-money round showed it as "Unknown" everywhere.
    Object.freeze({
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
    })
  ]),
  [NETWORK_KEYS.ETHEREUM]: Object.freeze([
    Object.freeze({
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    }),
    // USDT on Ethereum (prompt 0227, owner keputusan 0225 K8) — Tether's
    // own mainnet contract, chain-proven in the 0225 fase 2 evidence
    // (eth_getCode 11.075 bytes on two endpoints, symbol() "USDT",
    // name() "Tether USD", decimals() 6) AND CoinGecko-verified: GET
    // /coins/tether lists platforms.ethereum as exactly this address
    // (lowercased) — so portfolioValue's address-matched symbol map
    // prices it as 'tether' with zero new code. APPROVE IS NON STANDARD:
    // this contract reverts a non-zero approve while the live allowance
    // is non-zero ("To change the approve amount you first have to
    // reduce the addresses allowance to zero") — the swap flow's K8 rule
    // (approve(0) first when 0 < allowance < amountIn) exists for
    // exactly this token class.
    Object.freeze({
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      address: '0xdAC17F958D2ee523a2206206994597C13D831ec7'
    })
  ]),
  [NETWORK_KEYS.BASE]: Object.freeze([
    Object.freeze({
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    })
  ]),
  // BNB Chain. USDC stays deliberately absent, not a guess: the
  // commonly-referenced "USDC" on BNB Chain (0x8AC76a51...) is
  // Binance-Peg USDC — a third-party bridged token, not issued by
  // Circle — and Circle's own contract-address reference does not list
  // a native BNB Chain USDC at all, so no entry until a genuinely
  // Circle-verified address exists.
  //
  // USDT (prompt 0214, conscious owner decision): this is Binance-Peg
  // BSC-USD, ISSUED BY BINANCE as a bridged token — not a contract
  // deployed by Tether itself — but the contract's own on-chain
  // metadata reports symbol "USDT" / name "Tether USD" / decimals 18
  // (verified live on two RPC endpoints, 7 October 2026, prompt 0213
  // and 0214). CoinGecko lists it under its OWN id,
  // 'binance-bridged-usdt-bnb-smart-chain' (CoinGecko symbol
  // "bsc-usd"), NOT under 'tether' — verified live 7 October 2026:
  // GET /coins/binance-bridged-usdt-bnb-smart-chain returned
  // platforms: {"binance-smart-chain":
  // "0x55d398326f99059ff775485246999027b3197955"} (this exact
  // contract), while GET /coins/tether listed 11 platforms with no
  // binance-smart-chain entry at all. The portfolio feature prices it
  // by that bridged id via an address-keyed override — see
  // apps/extension/shared/portfolioValue.js. The address itself was
  // additionally verified by the owner against Binance's own USDT
  // BSC deposit/withdraw page and its linked explorer entry (prompt
  // 0213 Revisi 3, real 2.99 USDT deposit reconciled to the raw unit).
  [NETWORK_KEYS.BNB]: Object.freeze([
    Object.freeze({
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 18,
      address: '0x55d398326f99059fF775485246999027B3197955'
    })
  ])
});

/** Static registry entries for one network — never throws on an unknown key, just returns []. */
export function getTokensForNetwork(networkKey) {
  return TOKENS[networkKey] || [];
}

/**
 * Case-appropriate comparison key for a token address: EVM addresses are
 * commonly pasted/typed in mixed (checksum) case, so those compare
 * case-insensitively; Solana addresses are base58, where case is
 * significant to the value itself, so those compare exactly as given.
 *
 * Exported (not just used internally by mergeTokens below) so the
 * "Add custom token" flow's duplicate check
 * (apps/extension/background/background.js's FLUXIO_INTERNAL_ADD_CUSTOM_TOKEN
 * handler) can apply the exact same case-sensitivity rule when deciding
 * whether a newly-submitted address already exists in the registry or
 * custom list, instead of re-implementing (and risking drifting from)
 * this same rule a second time.
 */
export function normalizeTokenAddress(networkKey, address) {
  const network = NETWORKS[networkKey];
  return network?.accountType === ACCOUNT_TYPES.EVM ? address.toLowerCase() : address;
}

/**
 * Merges this file's static registry for `networkKey` with a caller-
 * supplied list of locally-registered custom tokens (see
 * apps/extension/background/background.js's FLUXIO_INTERNAL_GET_TOKEN_BALANCES
 * handler — the only real caller of this today, sourced from
 * chrome.storage.local's `fluxio_custom_tokens` key). A custom entry
 * whose address matches a registry entry replaces it (lets a stale
 * registry address be corrected locally without a code change); any
 * other custom entry is simply added. Order: registry entries first (in
 * their declared order), then any custom-only entries appended after.
 *
 * `customTokens` is already scoped to one network (a plain array), not
 * the full `{ [networkKey]: [...] }` storage shape — narrowing that
 * happens at the storage-reading call site, since only that call site
 * knows the storage shape.
 */
export function mergeTokens(networkKey, customTokens = []) {
  const registryTokens = getTokensForNetwork(networkKey);
  if (!customTokens.length) return registryTokens;

  const byAddress = new Map(registryTokens.map((token) => [normalizeTokenAddress(networkKey, token.address), token]));
  for (const custom of customTokens) {
    byAddress.set(normalizeTokenAddress(networkKey, custom.address), custom);
  }
  return [...byAddress.values()];
}
