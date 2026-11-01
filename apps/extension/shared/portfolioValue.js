/**
 * Pure decision/computation logic for the popup's portfolio-total feature
 * (prompt 0118) — given already-fetched (or already-failed) per-network
 * balances plus a batch of CoinGecko prices, decides which assets count
 * toward the total, sums them, and formats the result for the currently
 * selected fiat currency.
 *
 * *** BACKGROUND.JS-ONLY — NEVER IMPORT THIS FILE FROM AN UNBUNDLED PAGE ***
 * (popup.js, settings.js, onboarding.js, approval.js, content-script/*,
 * provider/*). This file imports `@fluxio/constants` (NETWORKS/TOKENS —
 * needed to know which networks are mainnet and which token address is
 * the registry's own USDC entry), and only esbuild's bundler (used
 * exclusively for background/background.js — see build.mjs) can actually
 * resolve that bare specifier. A browser loading an unbundled page's
 * module graph directly cannot, and throws
 * `Uncaught TypeError: Failed to resolve module specifier "@fluxio/constants"`
 * — this is EXACTLY the bug fixed in prompt 0118's own Revision 1 (see
 * prompt/0118-fiat-portfolio-value.md): the original version of this file
 * also exported plain UI constants (SUPPORTED_CURRENCIES etc.), and
 * popup.js/settings.js importing THOSE was enough to drag in this file's
 * `@fluxio/constants` import too (an ES module's own imports all execute
 * the moment the file loads, regardless of which exports the importer
 * actually uses) — crashing the popup outright in real Chrome, invisible
 * to `pnpm test` (Node resolves workspace packages fine) and to
 * `pnpm build:extension`/the e2e bundle tests (both only ever exercise
 * background.bundle.js, never popup.js's own unbundled module graph).
 *
 * The fix: every plain UI-safe constant/helper (currency list,
 * Intl.NumberFormat-based formatting, cache-staleness) now lives in the
 * sibling shared/portfolioDisplay.js instead, which has ZERO `@fluxio/*`
 * imports and is safe for popup.js/settings.js to import directly. THIS
 * file imports FROM that one (for isSupportedCurrency/formatCurrencyAmount/
 * DEFAULT_CURRENCY, used internally by computePortfolioTotal below),
 * never the other way around. A new automated guard,
 * test/unbundledNoBarePackageImports.test.js, now statically scans every
 * unbundled JS file and fails the moment ANY of them contains a bare
 * (non-relative) import specifier — this class of bug should never ship
 * silently again.
 *
 * Deliberately free of any DOM/`chrome.*`/`fetch` reference otherwise
 * (mirrors shared/swapAssetSources.js and shared/autoLockDecision.js's
 * own pattern, including taking `now` as an explicit parameter rather
 * than calling Date.now() itself, via portfolioDisplay.js's own
 * isPriceStale — so this stays fully unit-testable) — background.js is
 * the only caller, doing the actual balance/price fetching and handing
 * the results here.
 *
 * DESIGN DECISIONS BAKED IN HERE (reported, not silent):
 *
 * MAINNET-ONLY: computePortfolioTotal() below filters its OWN input to
 * mainnet networks (NETWORKS[key].isTestnet === false) rather than
 * trusting the caller to have already scoped it — this function is
 * independently correct even if handed a testnet entry by mistake, not
 * just correct "by construction" because background.js currently only
 * ever calls it with the 4 mainnet keys. A testnet entry, if present, is
 * silently dropped (not even surfaced as an "excluded asset" — testnet
 * value was never real money to begin with, so there's nothing to be
 * honest with the user ABOUT there, unlike a genuine mainnet asset this
 * phase just can't price).
 *
 * PRICE COVERAGE, PHASE 1 (see packages/services/priceService.js's own
 * header comment for the live verification behind this): every mainnet
 * native coin (SOL/ETH/BNB, Base reusing Ethereum's own price — Base's
 * native coin genuinely IS ether, not a distinct asset) plus ONLY the
 * token registry's own USDC entry per network (resolved against
 * packages/constants/tokens.js's TOKENS — the SAME registry
 * tokenService.js/background.js already treat as authoritative, never a
 * second hardcoded address list here). Any other token — a locally
 * registered custom token, or an unrecognized/foreign one a Solana
 * auto-discovery surfaced — has no price source this phase and is
 * excluded, honestly, via `excludedAssets`.
 *
 * NUMBER TYPE: plain JS `number`, not BigInt, for this module's own math
 * — a deliberate, explained divergence from this codebase's usual
 * "BigInt throughout for amount math" rule (packages/utils/formatUnits.js,
 * tokenService.js, balanceService.js, ...). That rule exists to prevent
 * precision loss converting a large ON-CHAIN raw integer amount to a
 * Number. Here, the INPUT is already a decimal-formatted display string
 * (`amountFormatted`/`formatted`, produced by formatUnits() upstream —
 * on-chain precision is already spent by that point) and the multiplier
 * is a fiat PRICE, which is inherently a floating-point value from
 * CoinGecko's own API with no BigInt-representable "raw" form to begin
 * with — there is no more-precise representation available to preserve.
 * This is a display total, never an amount fed back into a transaction,
 * so ordinary floating-point precision (more than sufficient for a fiat
 * total shown to 2 decimal places) is the right tool, not a shortcut.
 */
import { NETWORKS, NETWORK_KEYS, TOKENS, normalizeTokenAddress } from '@fluxio/constants';
import { DEFAULT_CURRENCY, isSupportedCurrency, formatCurrencyAmount } from './portfolioDisplay.js';

/** All configured mainnet network keys — isTestnet === false, derived once from the single source of truth (@fluxio/constants/networks.js), never hand-listed a second time. */
export const MAINNET_NETWORK_KEYS = Object.freeze(
  Object.values(NETWORKS)
    .filter((network) => network.isTestnet === false)
    .map((network) => network.key)
);

/** Native-coin CoinGecko id per mainnet network. Base intentionally maps to the same id as Ethereum — Base's native coin genuinely is ether (see NETWORKS.base.nativeCurrency), not a separate priced asset. */
const NATIVE_COIN_IDS = Object.freeze({
  [NETWORK_KEYS.SOLANA]: 'solana',
  [NETWORK_KEYS.ETHEREUM]: 'ethereum',
  [NETWORK_KEYS.BNB]: 'binancecoin',
  [NETWORK_KEYS.BASE]: 'ethereum'
});

/** CoinGecko's own coin id for USDC — see this file's header + priceService.js's header for the live verification that ties this id to the registry's own addresses. */
const USDC_COIN_ID = 'usd-coin';

/**
 * CoinGecko's own coin id for USDT (prompt 0212, owner opsi B) —
 * live-verified read-only on 5 Oktober 2026 against GET /coins/tether:
 * id "tether", symbol "usdt", and platforms.solana EXACTLY the
 * registry's own Solana USDT mint Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
 * (the 0206 registry entry) — the same id-to-registry-address tie-down
 * priceService.js's header records for usd-coin.
 */
const USDT_COIN_ID = 'tether';

/**
 * CoinGecko's own coin id for Binance-Peg BSC-USD, the BNB Chain "USDT"
 * (prompt 0214, owner keputusan 2) — live-verified read-only on
 * 7 Oktober 2026: GET /coins/binance-bridged-usdt-bnb-smart-chain
 * returned id "binance-bridged-usdt-bnb-smart-chain", symbol "bsc-usd",
 * and platforms["binance-smart-chain"] EXACTLY the registry's own BNB
 * Chain USDT contract 0x55d398326f99059ff775485246999027b3197955. It is
 * deliberately NOT priced as 'tether': the same live check showed
 * GET /coins/tether lists 11 platforms with NO binance-smart-chain entry
 * at all, so mapping this contract to 'tether' would break the
 * id-to-registry-address tie-down discipline this file follows for
 * usd-coin and tether (prompts 0203/0212).
 */
const BNB_USDT_COIN_ID = 'binance-bridged-usdt-bnb-smart-chain';

/** Coin id per REGISTRY SYMBOL this feature prices — the held token is always matched by ADDRESS against the registry entry (see resolveTokenCoinId), never by its own reported symbol; this map only names which registry entries have a verified CoinGecko id. */
const REGISTRY_TOKEN_COIN_IDS = Object.freeze({ USDC: USDC_COIN_ID, USDT: USDT_COIN_ID });

/**
 * Per-network, per-ADDRESS coin id overrides, checked BEFORE the
 * symbol-keyed map above (prompt 0214): a registry entry whose symbol
 * would resolve to the wrong global id gets its verified id pinned here
 * by normalized address. The one current case: BNB Chain's USDT is
 * Binance-Peg BSC-USD with its own CoinGecko id (see BNB_USDT_COIN_ID's
 * comment) — the symbol map alone would mislabel it as 'tether'.
 * Addresses are stored already-normalized (EVM lowercase).
 */
const TOKEN_COIN_ID_OVERRIDES = Object.freeze({
  [NETWORK_KEYS.BNB]: Object.freeze({
    '0x55d398326f99059ff775485246999027b3197955': BNB_USDT_COIN_ID
  })
});

/** Every CoinGecko coin id this feature could ever need to fetch, for building a batched request — used by background.js, not by computePortfolioTotal() itself (which only ever reads whatever pricesByCoinId it's handed). Still ONE batched /simple/price call: more ids only lengthen the same comma-joined URL. */
export const ALL_PRICED_COIN_IDS = Object.freeze([...new Set([...Object.values(NATIVE_COIN_IDS), USDC_COIN_ID, USDT_COIN_ID, BNB_USDT_COIN_ID])]);

/** @returns {string|null} the CoinGecko coin id for a mainnet network's native coin, or null if this network has none configured (should not happen for a real MAINNET_NETWORK_KEYS entry, but never assumed). */
export function resolveNativeCoinId(networkKey) {
  return NATIVE_COIN_IDS[networkKey] || null;
}

/**
 * @param {object} params
 * @param {string} params.networkKey
 * @param {string} params.address - the held token's contract/mint address.
 * @returns {string|null} the verified CoinGecko id when `address`
 *   matches (by normalized ADDRESS — EVM case-insensitive, Solana
 *   case-sensitive, the registry's own rule) a registry entry this
 *   feature prices (USDC → 'usd-coin', USDT → 'tether' as of prompt
 *   0212 opsi B; BNB Chain USDT → its own bridged id via
 *   TOKEN_COIN_ID_OVERRIDES as of prompt 0214), else null (no price
 *   source — the asset shows the ⓘ badge instead of a guessed price).
 */
export function resolveTokenCoinId({ networkKey, address }) {
  if (!address) return null;
  const normalized = normalizeTokenAddress(networkKey, address);
  // Address-level override first (prompt 0214): a pinned, individually
  // verified id always beats the symbol-keyed map below.
  const override = TOKEN_COIN_ID_OVERRIDES[networkKey]?.[normalized];
  if (override) return override;
  for (const entry of TOKENS[networkKey] || []) {
    const coinId = REGISTRY_TOKEN_COIN_IDS[entry.symbol];
    if (coinId && normalizeTokenAddress(networkKey, entry.address) === normalized) {
      return coinId;
    }
  }
  return null;
}

/**
 * Sums every mainnet asset's fiat value it has a price for, given
 * already-settled balance fetches (Promise.allSettled results, same
 * shape swapAssetSources.js already established a precedent for) and a
 * batch of CoinGecko prices. Never throws on a per-asset problem — a
 * failed fetch or an unpriceable asset is recorded in `excludedAssets`
 * and simply doesn't contribute to the total, exactly per this feature's
 * own "exclude honestly, don't hide it" requirement.
 *
 * @param {object} params
 * @param {Object<string, {
 *   nativeSettled: PromiseSettledResult<{formatted: string, symbol: string}>,
 *   tokenSettled: PromiseSettledResult<{tokens: Array<{symbol: string, address: string, amountFormatted: string}>}>
 * }>} params.perNetwork - keyed by network key. ANY key may be present,
 *   including a testnet one — this function filters to mainnet itself
 *   (see this file's own header comment), it does not trust the caller.
 * @param {Object<string, Object<string, number>>} params.pricesByCoinId
 * @param {string} params.currency - lowercase currency code.
 * @returns {{
 *   total: number, totalFormatted: string, currency: string,
 *   hasExcludedAssets: boolean,
 *   excludedAssets: Array<{ networkKey: string, kind: 'native'|'token'|'token-batch', symbol: string|null, reason: 'no-price'|'fetch-failed'|'malformed' }>
 * }}
 */
export function computePortfolioTotal({ perNetwork = {}, pricesByCoinId = {}, currency = DEFAULT_CURRENCY }) {
  const resolvedCurrency = isSupportedCurrency(currency) ? currency.toLowerCase() : DEFAULT_CURRENCY;
  let total = 0;
  const excludedAssets = [];

  for (const networkKey of Object.keys(perNetwork)) {
    const network = NETWORKS[networkKey];
    if (!network || network.isTestnet !== false) {
      // Not a real (mainnet) network, or unrecognized — silently skipped,
      // never counted, never reported as "excluded" (see header comment:
      // testnet value was never real money, there is nothing to be
      // honest with the user about here).
      continue;
    }
    const entry = perNetwork[networkKey] || {};

    accumulateNative({ networkKey, nativeSettled: entry.nativeSettled, pricesByCoinId, currency: resolvedCurrency, excludedAssets, add: (v) => (total += v) });
    accumulateTokens({ networkKey, tokenSettled: entry.tokenSettled, pricesByCoinId, currency: resolvedCurrency, excludedAssets, add: (v) => (total += v) });
  }

  return {
    total,
    totalFormatted: formatCurrencyAmount(total, resolvedCurrency),
    currency: resolvedCurrency,
    hasExcludedAssets: excludedAssets.length > 0,
    excludedAssets
  };
}

function accumulateNative({ networkKey, nativeSettled, pricesByCoinId, currency, excludedAssets, add }) {
  if (!nativeSettled) return;
  if (nativeSettled.status === 'rejected') {
    excludedAssets.push({ networkKey, kind: 'native', symbol: null, reason: 'fetch-failed' });
    return;
  }
  const { formatted, symbol } = nativeSettled.value || {};
  const coinId = resolveNativeCoinId(networkKey);
  const price = coinId ? pricesByCoinId?.[coinId]?.[currency] : undefined;
  const amount = Number(formatted);
  if (!Number.isFinite(amount)) {
    excludedAssets.push({ networkKey, kind: 'native', symbol: symbol ?? null, reason: 'malformed' });
    return;
  }
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    excludedAssets.push({ networkKey, kind: 'native', symbol: symbol ?? null, reason: 'no-price' });
    return;
  }
  add(amount * price);
}

/**
 * CONTRACT (tightened by prompt 0212, after the real silent-drop bug):
 * `tokenSettled.value` MUST be `{ tokens: Array<…> }` — the shape
 * background.js's fetchMainnetBalancesForPortfolio produces at its one
 * wrap point (see that function's own JSDoc for the incident). A BARE
 * ARRAY here is a caller bug, and it is rejected LOUDLY as a
 * 'malformed' batch exclusion rather than read as "no tokens": the
 * original bug read exactly that shape as `[]` and the owner's held
 * USDC silently vanished from the total with no ⓘ badge either.
 */
function accumulateTokens({ networkKey, tokenSettled, pricesByCoinId, currency, excludedAssets, add }) {
  if (!tokenSettled) return;
  if (tokenSettled.status === 'rejected') {
    // The whole network's token fetch failed (e.g. Solana mainnet's
    // documented getTokenAccountsByOwner gap — see tokenService.js's own
    // KNOWN ISSUE comment) — one exclusion entry for the whole batch,
    // not a crash, and not silently dropped either.
    excludedAssets.push({ networkKey, kind: 'token-batch', symbol: null, reason: 'fetch-failed' });
    return;
  }
  if (Array.isArray(tokenSettled.value)) {
    // Wrong shape from a caller (the exact 0212 bug class) — never
    // silently zero: the badge must show and the batch must be visible
    // as excluded until the caller is fixed.
    excludedAssets.push({ networkKey, kind: 'token-batch', symbol: null, reason: 'malformed' });
    return;
  }
  const tokens = tokenSettled.value?.tokens || [];
  for (const token of tokens) {
    const coinId = resolveTokenCoinId({ networkKey, address: token.address });
    const price = coinId ? pricesByCoinId?.[coinId]?.[currency] : undefined;
    const amount = Number(token.amountFormatted);
    if (!Number.isFinite(amount)) {
      excludedAssets.push({ networkKey, kind: 'token', symbol: token.symbol ?? null, reason: 'malformed' });
      continue;
    }
    if (typeof price !== 'number' || !Number.isFinite(price)) {
      excludedAssets.push({ networkKey, kind: 'token', symbol: token.symbol ?? null, reason: 'no-price' });
      continue;
    }
    add(amount * price);
  }
}
