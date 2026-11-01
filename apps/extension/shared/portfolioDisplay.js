/**
 * Pure, UI-safe portfolio-display constants/helpers (prompt 0118, split
 * out in a Revision 1 bug fix — see prompt/0118-fiat-portfolio-value.md's
 * own Revision 1 section for the full incident writeup). Deliberately
 * holds ONLY the currency-list/formatting/staleness concerns that never
 * need to know anything about this wallet's own networks or token
 * registry — genuinely just UI presentation logic, safe for an unbundled
 * page (popup.js, settings.js) to import directly, unlike its sibling
 * shared/portfolioValue.js.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM portfolioValue.js — THE BUG THIS
 * SPLIT FIXES: this repo's core architectural rule (CLAUDE.md, and every
 * unbundled page's own header comment) is that an unbundled extension
 * page may NEVER import an `@fluxio/*` workspace package — only
 * background.js (the one bundled entry point, via esbuild) can, because
 * only esbuild's bundler actually resolves a bare `@fluxio/constants`-
 * style specifier into real file content; a browser loading popup.html's
 * module graph directly has no such resolution step and throws
 * `Uncaught TypeError: Failed to resolve module specifier` instead. The
 * original portfolioValue.js (Revision 0) violated this: it needed
 * `@fluxio/constants` (NETWORKS/TOKENS) for its network/token-pricing
 * logic, but ALSO exported `SUPPORTED_CURRENCIES` — a plain UI constant
 * with NO dependency on wallet/network data — from the SAME file. Since
 * an ES module's imports all execute the moment the file loads,
 * REGARDLESS of which of its exports the importer actually uses,
 * popup.js/settings.js importing `SUPPORTED_CURRENCIES` from that one
 * file was enough to drag in the `@fluxio/constants` import too, and
 * crash. This file is the fix: every export here needs nothing from
 * `@fluxio/*`, ever — see the new automated guard,
 * test/unbundledNoBarePackageImports.test.js, which now fails the build
 * if this invariant is ever broken again, in this file or any other
 * unbundled one.
 *
 * `portfolioValue.js` (its sibling) keeps everything that genuinely needs
 * `@fluxio/constants` (network/registry data) — computePortfolioTotal()
 * and its own coin-id resolution — and stays background.js-only, by
 * design; it imports FROM this file (formatCurrencyAmount/
 * isSupportedCurrency/DEFAULT_CURRENCY), never the other way around, so
 * this file's own import graph stays clean no matter what its sibling
 * needs.
 */

export const DEFAULT_CURRENCY = 'usd';

/**
 * The Settings screen's Currency picker options — code + a representative
 * locale (used only by formatCurrencyAmount() below, for genuinely
 * currency-appropriate thousands/decimal separators) + a display label.
 * Every code here was confirmed against CoinGecko's own
 * `/simple/supported_vs_currencies` (live-verified, see priceService.js's
 * header) to be a currency CoinGecko actually prices — this is the
 * "minimal" list the spec asked for; CoinGecko supports many more
 * (~60), a genuine future expansion, not attempted this phase.
 */
export const SUPPORTED_CURRENCIES = Object.freeze([
  Object.freeze({ code: 'usd', label: 'US Dollar', locale: 'en-US' }),
  Object.freeze({ code: 'eur', label: 'Euro', locale: 'de-DE' }),
  Object.freeze({ code: 'gbp', label: 'British Pound', locale: 'en-GB' }),
  Object.freeze({ code: 'jpy', label: 'Japanese Yen', locale: 'ja-JP' }),
  Object.freeze({ code: 'idr', label: 'Indonesian Rupiah', locale: 'id-ID' }),
  Object.freeze({ code: 'sgd', label: 'Singapore Dollar', locale: 'en-SG' }),
  Object.freeze({ code: 'myr', label: 'Malaysian Ringgit', locale: 'ms-MY' }),
  Object.freeze({ code: 'aud', label: 'Australian Dollar', locale: 'en-AU' }),
  Object.freeze({ code: 'cad', label: 'Canadian Dollar', locale: 'en-CA' }),
  Object.freeze({ code: 'cny', label: 'Chinese Yuan', locale: 'zh-CN' }),
  Object.freeze({ code: 'krw', label: 'South Korean Won', locale: 'ko-KR' }),
  Object.freeze({ code: 'inr', label: 'Indian Rupee', locale: 'en-IN' })
]);

const SUPPORTED_CURRENCY_CODES = Object.freeze(new Set(SUPPORTED_CURRENCIES.map((c) => c.code)));

/** All currency codes this feature ever prices, for building a batched CoinGecko request (see priceService.js) — fetching every supported currency in one call means a later currency SWITCH never needs a new price fetch, only reformatting already-cached prices. */
export const ALL_SUPPORTED_CURRENCY_CODES = Object.freeze(SUPPORTED_CURRENCIES.map((c) => c.code));

export function isSupportedCurrency(code) {
  return typeof code === 'string' && SUPPORTED_CURRENCY_CODES.has(code.toLowerCase());
}

/**
 * ISO 4217 defines IDR with 2 minor units — but live-verified (Node's
 * Intl, the same ICU data Chrome's V8 uses) that Intl.NumberFormat's
 * DEFAULT rendering for IDR is 2 decimals, which does not match the
 * lazim (customary) convention the spec explicitly called out
 * ("IDR/JPY/KRW yang lazim tanpa desimal"). JPY and KRW already default
 * to 0 decimals (their own ISO 4217 minor unit genuinely is 0, no
 * override needed) — IDR is the one genuine exception found by actually
 * running Intl.NumberFormat, not assumed from ISO 4217 alone, so it's
 * the one explicit override here.
 */
const ZERO_DECIMAL_CURRENCIES = Object.freeze(new Set(['jpy', 'krw', 'idr']));

/**
 * Formats a plain-number fiat amount per its currency's own convention —
 * symbol, thousands separator, decimal count — via Intl.NumberFormat,
 * never hand-rolled, using each currency's representative locale from
 * SUPPORTED_CURRENCIES (not the caller's own browser locale): "follow the
 * CURRENCY's convention" (the spec's own words) means Rupiah should
 * always render Indonesian-style regardless of what locale the browser
 * happens to be in, not the other way around.
 * @param {number} amount
 * @param {string} currency - lowercase currency code.
 * @returns {string}
 */
export function formatCurrencyAmount(amount, currency) {
  const code = isSupportedCurrency(currency) ? currency.toLowerCase() : DEFAULT_CURRENCY;
  const entry = SUPPORTED_CURRENCIES.find((c) => c.code === code);
  const options = { style: 'currency', currency: code.toUpperCase() };
  if (ZERO_DECIMAL_CURRENCIES.has(code)) {
    options.minimumFractionDigits = 0;
    options.maximumFractionDigits = 0;
  }
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat(entry.locale, options).format(safeAmount);
  } catch {
    // Defensive only — every code reaching here already passed
    // isSupportedCurrency(), so a real Intl.NumberFormat RangeError
    // shouldn't be reachable; kept as a fail-safe rather than letting a
    // formatting quirk crash the whole popup render.
    return `${safeAmount.toFixed(2)} ${code.toUpperCase()}`;
  }
}

/**
 * A cached price snapshot is considered stale (should be refetched, and
 * should be labeled as possibly-outdated if shown before a fresh fetch
 * resolves) once it's older than this. One threshold serves BOTH
 * purposes deliberately (see background.js's own use of this) — there's
 * no clear reason "should I bother CoinGecko again" and "should I tell
 * the user this number might be old" need two different arbitrary
 * numbers; keeping one avoids introducing a second policy constant with
 * no principled way to pick its value differently from this one. Chosen
 * as a conservative multiple of CoinGecko's own `Cache-Control: max-age=30`
 * on the /simple/price response itself (live-verified, see
 * priceService.js's own header comment) — CoinGecko's own edge cache
 * only refreshes every 30s regardless, so refetching more often than
 * that would never even see new data.
 */
export const PRICE_CACHE_MAX_AGE_MS = 30_000;

/**
 * Pure "is this cached price data too old to trust as fresh" decision —
 * mirrors autoLockDecision.js's shouldAutoLock() shape exactly (explicit
 * `now`, fails toward the SAFER outcome on missing/corrupt input). The
 * cost of being wrong here is much lower than auto-lock's (a stale-looking
 * subtext, or one extra CoinGecko call) — not a security property — but
 * the same "don't silently trust corrupt data" instinct still applies:
 * a missing/non-finite timestamp is treated as stale, never as fresh.
 * @param {object} params
 * @param {number} params.fetchedAt - epoch ms the cached prices were fetched, or a non-finite value if never fetched.
 * @param {number} params.now - epoch ms "now".
 * @param {number} [params.maxAgeMs]
 * @returns {boolean}
 */
export function isPriceStale({ fetchedAt, now, maxAgeMs = PRICE_CACHE_MAX_AGE_MS }) {
  if (!Number.isFinite(fetchedAt) || !Number.isFinite(now)) {
    return true;
  }
  return now - fetchedAt >= maxAgeMs;
}
