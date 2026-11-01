/**
 * Pure decision logic for the Swap screen's data-loading resilience
 * (prompt 0116, fixing a real bug found in manual verification): given
 * the outcome of the three parallel fetches a Swap-screen render needs
 * (native SOL balance, held-token balances, Jupiter's verified token
 * list), decides whether a failure is FATAL (nothing sensible can be
 * shown at all) or should DEGRADE gracefully (the screen still works,
 * just with reduced "You pay" options).
 *
 * Native balance and the verified token list are load-bearing: without
 * native SOL there is no "You pay" asset at all (every wallet always
 * holds a Solana account, but the amount is unknown without this call),
 * and without the verified list there is no "You receive" data at all —
 * either failing is genuinely fatal to the screen.
 *
 * Held-TOKEN balances are explicitly NOT load-bearing: a swap quote never
 * needed a token balance to begin with (Jupiter's quote endpoint doesn't
 * ask for one) — the balance is only ever used to populate extra "You
 * pay" options beyond native SOL. This is the actual bug this file fixes:
 * a getTokenAccountsByOwner failure on the mainnet RPC endpoint (a real,
 * confirmed, currently-unresolved gap — see tokenService.js's own KNOWN
 * ISSUE comment) used to take the ENTIRE Swap screen down with a
 * full-screen error, even though nothing about quoting or reviewing a
 * SOL-denominated swap ever depended on that call succeeding.
 *
 * Deliberately kept free of any DOM/`chrome.*` reference — this is what
 * makes it unit-testable with plain Vitest (see shared/test/
 * swapAssetSources.test.js), the first such precedent for anything in
 * apps/extension: everywhere else in this codebase, "no test precedent
 * exists for popup.js/background.js" has meant no new test infrastructure
 * was invented (see prompt 0115's own report) — this function was
 * deliberately EXTRACTED out of popup.js's DOM-manipulating render
 * function specifically so a real, correctly-scoped precedent could
 * exist for the one piece of this feature that's pure decision logic,
 * without needing a jsdom/chrome-API mock harness for the rest of
 * popup.js (which still has none, and isn't attempted here).
 *
 * @param {object} params
 * @param {PromiseSettledResult<{formatted: string, symbol: string}>} params.nativeSettled - FLUXIO_INTERNAL_GET_BALANCE's settled result.
 * @param {PromiseSettledResult<{tokens: Array}>} params.tokenSettled - FLUXIO_INTERNAL_GET_TOKEN_BALANCES's settled result.
 * @param {PromiseSettledResult<{tokens: Array}>} params.verifiedSettled - FLUXIO_INTERNAL_GET_SWAP_TOKENS's settled result.
 * @returns {
 *   { fatal: true, error: Error } |
 *   { fatal: false, nativeBalance: string, nativeSymbol: string, tokens: Array,
 *     verifiedTokens: Array, tokenBalancesDegraded: boolean, tokenBalancesError: string|null }
 * }
 */
export function resolveSwapAssetSources({ nativeSettled, tokenSettled, verifiedSettled }) {
  if (nativeSettled.status === 'rejected') {
    return { fatal: true, error: nativeSettled.reason };
  }
  if (verifiedSettled.status === 'rejected') {
    return { fatal: true, error: verifiedSettled.reason };
  }

  const tokenBalancesDegraded = tokenSettled.status === 'rejected';
  return {
    fatal: false,
    nativeBalance: nativeSettled.value.formatted,
    nativeSymbol: nativeSettled.value.symbol,
    tokens: tokenBalancesDegraded ? [] : tokenSettled.value.tokens,
    verifiedTokens: verifiedSettled.value.tokens,
    tokenBalancesDegraded,
    tokenBalancesError: tokenBalancesDegraded ? tokenSettled.reason?.message || 'Token balances unavailable.' : null
  };
}
