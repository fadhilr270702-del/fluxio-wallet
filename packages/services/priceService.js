/**
 * Fiat prices via CoinGecko's public API — no API key, free/keyless tier.
 * Powers the popup's portfolio-total feature (prompt 0118): a single
 * batched request returns every native-coin/registry-token price this
 * wallet needs, in every currency the Settings screen offers, so a
 * later currency switch never needs a second network call (see
 * apps/extension/shared/portfolioValue.js, which owns that decision —
 * this file only ever fetches whatever coin ids/currencies it's asked
 * for, it doesn't decide what to ask for).
 *
 * Same boundary/discipline as swapService.js (this package's closest
 * sibling): never imports walletService, never sees a seed or address —
 * this is a plain price lookup, no wallet identity involved at all. One
 * base URL constant, a real fetch with a timeout, consistent error
 * surfacing.
 *
 * ENDPOINT VERIFICATION (explicitly requested — reported honestly):
 * live-verified with real `curl` requests against the actual API at the
 * time this was written, not copied from stale training data.
 *   - LIVE-VERIFIED: `GET /simple/price?ids=<comma-list>&vs_currencies=<comma-list>`
 *     returns exactly the `{ [coinId]: { [currency]: number } }` shape
 *     this file returns unmodified. Batching MANY coin ids AND many
 *     vs_currencies together in ONE request works fine on the free tier
 *     (tested with `solana,ethereum,binancecoin,usd-coin` × all 12
 *     currencies this wallet supports, one single 200 response, no
 *     rate-limit signal). `GET /simple/supported_vs_currencies` was used
 *     to confirm all 12 of this wallet's supported currencies (usd, eur,
 *     gbp, jpy, idr, sgd, myr, aud, cad, cny, krw, inr) are genuinely
 *     supported — they are, all 12 present in the real response.
 *   - LIVE-VERIFIED AND IMPORTANT, changed this feature's architecture:
 *     `GET /simple/token_price/{platformId}?contract_addresses=<list>`
 *     — the natural-looking endpoint for pricing an arbitrary SPL/ERC-20
 *     token by contract address — genuinely works on the free tier for
 *     exactly ONE contract address per request as of this writing
 *     (verified with real USDC contracts on both `ethereum` and `solana`
 *     platform ids). Requesting TWO addresses in one call was REJECTED
 *     live with `error_code: 10012, "Number of contract addresses...
 *     exceeds the allowed limit of 1 contract address... subscribe to
 *     Demo plan or a paid plan"`. This directly contradicts what would
 *     be needed to satisfy this feature's own "max one price call per
 *     popup open" requirement for any wallet holding more than one
 *     priced token across networks — so `token_price` is NOT used here
 *     at all this phase, for any token, regardless of how many are held.
 *   - WORKAROUND, ALSO LIVE-VERIFIED: CoinGecko has its own coin id for
 *     USDC itself — `usd-coin` — fetchable through the SAME batchable
 *     `/simple/price` endpoint used for native coins (no per-contract
 *     limit at all there). Confirmed via `GET /coins/usd-coin` that its
 *     `platforms.ethereum`/`platforms.base`/`platforms.solana` addresses
 *     are byte-for-byte the exact same Circle-verified addresses already
 *     hardcoded in packages/constants/tokens.js's TOKENS registry — so
 *     "usd-coin" is confirmed to be the correct id for the registry's
 *     USDC entries, not a guess. This is exactly the scope-cut the
 *     feature's own spec anticipated ("kalau ternyata endpoint kontrak
 *     tidak layak di tier gratis, fase ini cukup native + token registry
 *     yang punya id CoinGecko yang kamu verifikasi (USDC), sisanya 'tanpa
 *     harga'") — decided from this real verification, not assumed:
 *     Phase 1 prices native coins (SOL/ETH/BNB, Base reusing ETH) plus
 *     ONLY the registry's USDC entries (solana/ethereum/base — BNB has no
 *     registry USDC entry to begin with, see tokens.js's own comment).
 *     Any other held token (a custom-registered one, or an
 *     unrecognized/foreign one) has no price source this phase and is
 *     excluded from the total — see portfolioValue.js's own
 *     resolveTokenCoinId().
 *   - No rate-limit headers are returned on a successful response (no
 *     `x-ratelimit-*` headers observed), so this file can't cite an
 *     exact number from live evidence — CoinGecko's own publicly
 *     documented free/demo tier is commonly cited as roughly 10-30
 *     calls/minute per IP, but that specific number was NOT independently
 *     re-verified here (would require deliberately exhausting the limit,
 *     not attempted). The "max one price call per popup open, min 30s
 *     between calls on repeated Refresh" design in
 *     background.js/FLUXIO_INTERNAL_GET_PORTFOLIO_VALUE is deliberately
 *     far more conservative than even the low end of that commonly-cited
 *     range, so this wallet should never come close to it regardless of
 *     the exact true limit.
 */

const COINGECKO_API_BASE = 'https://api.coingecko.com/api/v3';
const SIMPLE_PRICE_PATH = '/simple/price';
const PRICE_FETCH_TIMEOUT_MS = 8000;

/**
 * Fetches fiat prices for a batch of CoinGecko coin ids, in a batch of
 * vs_currencies, as ONE HTTP request — the caller (background.js) is
 * responsible for batching everything it needs into a single call rather
 * than calling this once per coin/currency; see this file's own header
 * comment for why that matters on the free tier.
 *
 * @param {object} params
 * @param {string[]} params.coinIds - CoinGecko coin ids, e.g. ['solana', 'ethereum', 'usd-coin'].
 * @param {string[]} params.vsCurrencies - lowercase ISO 4217-ish currency codes, e.g. ['usd', 'idr'].
 * @returns {Promise<Object<string, Object<string, number>>>} e.g. { solana: { usd: 78.3, idr: 1394754 } }
 *   — an empty object if coinIds or vsCurrencies is empty (no call made
 *   at all in that case — nothing to ask for).
 */
export async function getPrices({ coinIds = [], vsCurrencies = [] } = {}) {
  const ids = dedupeNonEmpty(coinIds);
  const currencies = dedupeNonEmpty(vsCurrencies);
  if (!ids.length || !currencies.length) {
    return {};
  }

  const params = new URLSearchParams({
    ids: ids.join(','),
    vs_currencies: currencies.join(',')
  });

  return fetchCoinGecko(`${SIMPLE_PRICE_PATH}?${params.toString()}`);
}

function dedupeNonEmpty(values) {
  return [...new Set(values.filter((v) => typeof v === 'string' && v.length > 0))];
}

/** Real fetch, with a timeout and consistent error surfacing — mirrors swapService.js's own fetchJupiter, adapted for CoinGecko's plain-REST (no {error}-envelope-on-200) shape. */
async function fetchCoinGecko(path) {
  let response;
  try {
    response = await withTimeout(fetch(`${COINGECKO_API_BASE}${path}`), PRICE_FETCH_TIMEOUT_MS);
  } catch (err) {
    throw new Error(`Could not reach CoinGecko: ${err?.message || 'unknown error'}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`CoinGecko returned a non-JSON response (status ${response.status}).`);
  }

  if (!response.ok) {
    // CoinGecko's own error shape (e.g. the token_price 1-contract limit
    // documented in this file's header) is { error_code, status: { error_message } }
    // on a non-200 — surfaced here, not treated as an opaque transport failure.
    const message = data?.status?.error_message || data?.error || `CoinGecko request failed (status ${response.status}).`;
    throw new Error(message);
  }
  if (!data || typeof data !== 'object') {
    throw new Error('CoinGecko returned an unexpected response shape.');
  }
  return data;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out.')), ms))]);
}
