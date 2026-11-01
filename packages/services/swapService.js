/**
 * Solana token swaps via Jupiter's public aggregator API — Phase 1 (prompt
 * 0115): real, free, read-only quotes; execution deliberately disabled.
 * Jupiter only ever routes Solana MAINNET liquidity — there is no
 * devnet/local-validator equivalent, so unlike transactionService.js/
 * evmTransactionService.js (which are parameterized by `networkKey` and
 * work across several networks per chain family), every function here is
 * implicitly Solana-mainnet-only and takes no `networkKey` at all. The
 * caller (background.js) is responsible for only ever reaching this
 * module when the active network really is `'solana'` — see its own
 * FLUXIO_INTERNAL_GET_SWAP_QUOTE handler.
 *
 * Same signing/trust boundary as every other transaction-adjacent service
 * in this package: this file NEVER imports walletService and never sees a
 * seed or private key. `buildSwapTransaction()` only ever produces an
 * UNSIGNED serialized transaction (Jupiter's own /swap response) — there
 * is no `sendSwapTransaction()`/`executeSwap()` export here at all this
 * phase, deliberately: the thing that would sign-and-broadcast a swap
 * doesn't exist yet, so there's nothing to accidentally wire up. The
 * actual "swap execution is disabled" behavior lives one layer up, in
 * background.js's FLUXIO_INTERNAL_EXECUTE_SWAP handler, which rejects
 * unconditionally before ever calling into this file — see that handler's
 * own comment for why the guard lives there and not here.
 *
 * All raw amounts are BigInt end to end (same discipline as every other
 * services file) — Jupiter's own quote response already returns amounts
 * as decimal-string integers (no `.` inside), so `BigInt(...)` parses
 * them directly, same as an EVM `eth_getBalance` hex string elsewhere in
 * this codebase.
 *
 * ENDPOINT VERIFICATION (explicitly requested — reported honestly, not
 * silently assumed): checked against Jupiter's own public sources AND
 * live-verified with real requests against the actual API at the time
 * this was written (`curl`, from this environment, not just read about) —
 * not copied from stale training data.
 *   - LIVE-VERIFIED (real HTTP requests, real 200 responses, response
 *     shape inspected by hand): `GET https://lite-api.jup.ag/swap/v1/quote`
 *     (params: inputMint, outputMint, amount, slippageBps, optional
 *     platformFeeBps) returns exactly the `{inputMint, inAmount,
 *     outputMint, outAmount, otherAmountThreshold, slippageBps,
 *     platformFee, priceImpactPct, routePlan, ...}` shape this file
 *     parses; `POST https://lite-api.jup.ag/swap/v1/swap` (body:
 *     userPublicKey, quoteResponse, optional feeAccount) genuinely
 *     returns `{ swapTransaction: <base64> }` for a real quote + an
 *     arbitrary (unfunded, not-owned-by-anyone) valid address; and
 *     `GET https://lite-api.jup.ag/tokens/v2/tag?query=verified` returns
 *     a real ~3900-entry array whose shape (`id`, `name`, `symbol`,
 *     `decimals`, `icon`, ...) exactly matches this file's `id`/`icon`
 *     normalization branch. Also confirmed directly: this host needs no
 *     API key and no `host_permissions` origin problem the way a local
 *     validator did in prompt 0091 — the plain `curl`/`fetch` calls above
 *     succeeded with zero extra configuration.
 *   - This also confirms Jupiter's own OpenAPI spec file
 *     (github.com/jup-ag/jupiter-quote-api-node/blob/main/swagger.yaml,
 *     fetched directly, base host documented there as `api.jup.ag`) and
 *     the `lite-api.jup.ag` host (Jupiter's unauthenticated "Keyless"
 *     tier, ~0.5 req/s / 30 req/min per Jupiter's own rate-limits doc)
 *     serve the identical `/swap/v1/*` paths — this module uses
 *     `lite-api.jup.ag` specifically because this is a browser extension
 *     with no server-side secret store to hold an API key, and Phase 1's
 *     quotes are meant to be free/keyless.
 *   - Jupiter also has a newer unified `/swap/v2/order`+`/swap/v2/execute`
 *     flow (per Jupiter's own changelog, "Swap API V2" launched March
 *     2026) that merges quote+build into one call — NOT used here, since
 *     the two-step quote-then-build shape this feature's architecture
 *     explicitly asks for (`getSwapQuote()` separate from
 *     `buildSwapTransaction()`) maps directly onto the older, still-live
 *     `/swap/v1/*` pair instead.
 *   - If `lite-api.jup.ag` is ever fully deprecated (as of this writing,
 *     search results describe its shutdown as "postponed... no immediate
 *     deadline", not yet final), migrating to `api.jup.ag` needs two
 *     changes: JUPITER_API_BASE below, and adding an `x-api-key` header
 *     to fetchJupiter()'s request — neither exists in this file yet,
 *     flagged here so that migration isn't a surprise.
 */
import { PublicKey } from '@solana/web3.js';

/**
 * The one place this module's Jupiter host lives — see the endpoint-
 * verification note above for its confidence level and what changes if
 * it moves. Every path below is built from this single constant.
 */
const JUPITER_API_BASE = 'https://lite-api.jup.ag';
const JUPITER_QUOTE_PATH = '/swap/v1/quote';
const JUPITER_SWAP_BUILD_PATH = '/swap/v1/swap';
const JUPITER_VERIFIED_TOKENS_PATH = '/tokens/v2/tag?query=verified';
const JUPITER_FETCH_TIMEOUT_MS = 8000;

/** Wrapped SOL's mint address — the canonical "native SOL" input/output mint every Jupiter integration uses, since SPL instructions can only ever move SPL token accounts, never the native lamports balance directly. */
export const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Jupiter v6 swap program id (prompt 0210) — the ONE place this address
 * lives in product code. Every swap this wallet has ever built through
 * Jupiter's /swap endpoint carries exactly one TOP-LEVEL instruction to
 * this program, and the program sits in the STATIC accountKeys (source
 * "transaction", never behind an address lookup table) — proven against
 * five real mainnet swaps incl. one on-chain failure in 0210 fase 1.
 * historyService uses it to recognize a Jupiter swap in chain-only
 * history (a swap made on another device/install of this same wallet);
 * swapService itself never needs it at request time (Jupiter's REST API
 * is addressed by URL, not program id) — it lives here because this
 * file is the swap domain's constants home (SWAP_FEE_ACCOUNTS,
 * NATIVE_SOL_MINT above), not in @fluxio/constants, whose scope is
 * networks/tokens, not third-party program ids.
 */
export const JUPITER_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

/**
 * Platform fee, prepared but NOT enabled — see SWAP_FEE_ACCOUNTS below for
 * exactly what "enabled" means and why it isn't yet. 85 bps = 0.85%.
 */
export const SWAP_FEE_BPS = 85;

/**
 * Per-mint Jupiter fee token accounts. Jupiter's `feeAccount` parameter
 * must be an already-initialized SPL token account whose mint matches
 * either side of the swap (see buildSwapTransaction below) — collecting
 * a platform fee therefore needs a real, rent-funded token account this
 * project's treasury controls for every mint a fee might be charged on.
 *
 * FILLED as of prompt 0203 with exactly ONE entry — USDC, per the
 * standing 0199/0200 decision that the 0.85% fee applies only to pairs
 * with USDC on one side (output side wins, see resolveFeeAccount). The
 * account is the treasury wallet's own USDC associated token account:
 *   owner  FnjdJcYsQShxUTPJjgVnjjvw5kKsVwfxtFCWBJMjPiwQ  (the owner's
 *          Phantom "akun treasury" wallet)
 *   ATA    derived deterministically (owner + Token Program + USDC mint
 *          via the Associated Token Program) and verified initialized
 *          on-chain (Token Program-owned, correct mint/owner, funded)
 *          before being recorded here — see prompt 0203's archive.
 *
 * getSwapQuote()/the FLUXIO_INTERNAL_GET_SWAP_QUOTE handler in
 * background.js only ever include `platformFeeBps` in a quote request
 * when BOTH a `feeBps` AND a `feeAccount` are explicitly passed in — see
 * getSwapQuote's own comment. A pair with no entry on either side (e.g.
 * SOL -> BONK) still resolves NO fee account and runs fee-free, by
 * construction, not by a separate on/off flag that could be forgotten.
 */
export const SWAP_FEE_ACCOUNTS = Object.freeze({
  // USDC mint -> treasury's USDC ATA (prompt 0203, owner FnjdJ…PiwQ).
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: '6tyoAgzhyGgGNrxyyR68DHvfUySo4kdh1RukgU78Ep2j'
});

/**
 * The wallet that OWNS every fee account in SWAP_FEE_ACCOUNTS (prompt
 * 0209, owner decision 4). Until now this address lived only in the
 * comment above; the fee-account guard's validity check compares the
 * on-chain account's parsed owner against it, so it must be code, not
 * commentary. An ATA at the recorded address can only ever exist as
 * this owner's token account for that mint (it is a PDA of owner+mint),
 * but the check also protects a FUTURE map edit from a mistyped
 * address — see the 0208 incident (lesson #8) this guard exists for.
 */
export const SWAP_FEE_ACCOUNT_OWNER = 'FnjdJcYsQShxUTPJjgVnjjvw5kKsVwfxtFCWBJMjPiwQ';

/**
 * Priority-fee cap (prompt 0206 butir 5, owner opsi A). Every Jupiter
 * build request — preview AND execute, which both flow through
 * buildSwapTransaction() below — asks for `priorityLevelWithMaxLamports:
 * { maxLamports: SWAP_PRIORITY_FEE_CAP_LAMPORTS, priorityLevel: 'high' }`
 * (documented on developers.jup.ag's build-swap-transaction page and
 * live-proven in this prompt's fase 1: across repeated real builds the
 * response's prioritizationFeeLamports never exceeded the requested cap).
 * The UI can therefore show "Network fee (max)" = base 5000 + this cap as
 * a hard ceiling instead of an "~" estimate. buildSwapTransaction() also
 * REJECTS pre-sign (SWAP_PRIORITY_FEE_ABOVE_CAP) if a response ever comes
 * back above the cap anyway — the display promise must never be able to
 * silently break on a Jupiter behavior change.
 */
export const SWAP_PRIORITY_FEE_CAP_LAMPORTS = 150000;
export const SWAP_PRIORITY_FEE_LEVEL = 'high';

/**
 * Emergency build switch (prompt 0200, owner decision) — background.js's
 * FLUXIO_INTERNAL_EXECUTE_SWAP refuses outright while this is false, before
 * any other check. Not a feature flag: execution is otherwise governed by
 * its real conditions (unlocked session, mainnet network, valid quoteId).
 * Flip to false only to ship a build with swap execution force-disabled.
 */
export const SWAP_EXECUTION_ENABLED = true;

/**
 * K2b (prompt 0200, owner decision): the 0.85% fee applies only when the
 * INPUT or OUTPUT mint has an entry in SWAP_FEE_ACCOUNTS — output side
 * wins when both do (ExactIn semantics: Jupiter allows the feeAccount's
 * mint to be EITHER side of an ExactIn pair, proven against the live API
 * and its docs in prompt 0199). A pair with no entry on either side runs
 * with NO fee at all — the caller must then omit platformFeeBps entirely,
 * because a fee-carrying quote without a feeAccount is REJECTED by
 * Jupiter's /swap (live-proven 400 "feeAccount is required for swap with
 * platformFee"), not silently ignored.
 * @param {string} inputMint
 * @param {string} outputMint
 * @param {Record<string,string>} [feeAccounts] - injectable for tests; defaults to SWAP_FEE_ACCOUNTS.
 * @returns {{ feeAccount: string, feeMint: string, feeSide: 'output'|'input' } | null}
 */
export function resolveFeeAccount(inputMint, outputMint, feeAccounts = SWAP_FEE_ACCOUNTS) {
  if (feeAccounts[outputMint]) {
    return { feeAccount: feeAccounts[outputMint], feeMint: outputMint, feeSide: 'output' };
  }
  if (feeAccounts[inputMint]) {
    return { feeAccount: feeAccounts[inputMint], feeMint: inputMint, feeSide: 'input' };
  }
  return null;
}

/**
 * The platform-fee amount to DISPLAY and RECORD, corrected per fee side
 * (prompt 0203 Revisi 3 — a real-money display bug). Live-proven with a
 * real quote (USDC->SOL 0.480995, platformFeeBps=85): Jupiter's
 * `quote.platformFee.amount` is ALWAYS denominated in the OUTPUT mint —
 * the quote answered `{"amount":"42064"}`, exactly 0.85% of its own
 * outAmount in LAMPORTS — even when the fee is actually charged on the
 * INPUT side at build time (the feeAccount's mint is the input mint).
 * The owner's real swap confirmed the chain truth: the treasury USDC ATA
 * rose by exactly 4088 raw = floor(480995 × 85 / 10000) — 0.85% of the
 * INPUT — while Review displayed the quote's output-denominated 42124
 * at the input's 6 decimals as "0.042124 USDC" (~10x off).
 *
 * So: for an INPUT-side fee the displayed/recorded amount is computed
 * here from the input amount directly (BigInt floor — matches the
 * on-chain 4088 exactly); for an OUTPUT-side fee Jupiter's own number
 * passes through unchanged (proven correct on chain: swap 1's quote fee
 * matched the treasury's +4123 raw).
 * @param {object} params
 * @param {'input'|'output'} params.feeSide - from resolveFeeAccount.
 * @param {number} params.feeBps - the platform fee in bps (SWAP_FEE_BPS).
 * @param {bigint} params.inAmountRaw - the quote's input amount, raw.
 * @param {bigint|null} params.quoteFeeAmountRaw - Jupiter's platformFee.amount (output-denominated).
 * @returns {bigint|null}
 */
export function computePlatformFeeDisplayRaw({ feeSide, feeBps, inAmountRaw, quoteFeeAmountRaw }) {
  if (feeSide === 'input') {
    return (inAmountRaw * BigInt(feeBps)) / 10000n;
  }
  return quoteFeeAmountRaw ?? null;
}

/** Thrown for any caller/input problem (invalid mint, invalid amount, ...) — as opposed to a Jupiter API failure. Mirrors transactionService.js's TransactionValidationError. */
export class SwapValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SwapValidationError';
    this.code = code;
  }
}

/**
 * Fetches a real quote from Jupiter for swapping `amountRaw` of
 * `inputMint` into `outputMint`. Read-only — no signing, no wallet
 * address involved at all (Jupiter's quote endpoint doesn't need one;
 * only the later build step does).
 *
 * @param {object} params
 * @param {string} params.inputMint - base58 SPL mint address (or NATIVE_SOL_MINT).
 * @param {string} params.outputMint
 * @param {bigint|string} params.amountRaw - amount of `inputMint`, in its smallest unit.
 * @param {number} params.slippageBps - 1-5000 (0.01%-50%).
 * @param {number} [params.feeBps] - only ever included in the actual
 *   Jupiter request when `feeAccount` is ALSO given — the "fee only
 *   applies when a fee account exists for this output mint" rule lives
 *   right here, not just in the caller, so this function can't be
 *   accidentally called in a way that requests a fee with nowhere to
 *   send it (Jupiter would reject that combination anyway, but failing
 *   closed here is clearer than relying on their validation).
 * @param {string} [params.feeAccount] - unused by getSwapQuote itself
 *   (Jupiter's /quote has no feeAccount param — only /swap does), but
 *   required alongside `feeBps` for the SAME reason as above: passing one
 *   without the other is almost certainly a caller bug.
 * @returns {Promise<{
 *   inputMint: string, outputMint: string,
 *   inAmountRaw: bigint, outAmountRaw: bigint, minReceivedRaw: bigint,
 *   priceImpactPct: number, slippageBps: number,
 *   feeIncluded: boolean, feeBps: number|null, feeAmountRaw: bigint|null,
 *   raw: object
 * }>}
 */
export async function getSwapQuote({ inputMint, outputMint, amountRaw, slippageBps, feeBps, feeAccount }) {
  requireValidMint(inputMint, 'Input token');
  requireValidMint(outputMint, 'Output token');
  const amountValue = requirePositiveAmount(amountRaw);
  const slippageValue = requireValidSlippageBps(slippageBps);

  const includeFee = feeBps != null && !!feeAccount;
  if ((feeBps != null) !== !!feeAccount) {
    // Only one of the pair was supplied — almost certainly a caller bug
    // (see this function's own param docs) rather than a real "half a
    // fee" request; fail loudly instead of silently either dropping or
    // guessing the other half.
    throw new SwapValidationError('INCOMPLETE_FEE_PARAMS', 'feeBps and feeAccount must both be provided together, or both omitted.');
  }

  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountValue.toString(),
    slippageBps: String(slippageValue)
  });
  if (includeFee) {
    params.set('platformFeeBps', String(feeBps));
  }

  const data = await fetchJupiter(`${JUPITER_QUOTE_PATH}?${params.toString()}`);
  return parseQuoteResponse(data);
}

function parseQuoteResponse(data) {
  if (!data || data.inAmount == null || data.outAmount == null) {
    throw new Error('Jupiter returned an incomplete quote (no route found for this pair/amount).');
  }
  const platformFee = data.platformFee;
  return {
    inputMint: data.inputMint,
    outputMint: data.outputMint,
    inAmountRaw: BigInt(data.inAmount),
    outAmountRaw: BigInt(data.outAmount),
    // "Minimum received after slippage" — Jupiter's own otherAmountThreshold
    // field is exactly this, no need to hand-derive it from outAmount and
    // slippageBps ourselves (and Jupiter's own rounding may not match a
    // naive percentage calculation exactly).
    minReceivedRaw: BigInt(data.otherAmountThreshold ?? data.outAmount),
    priceImpactPct: Number(data.priceImpactPct ?? 0),
    slippageBps: Number(data.slippageBps ?? 0),
    feeIncluded: !!platformFee,
    feeBps: platformFee ? Number(platformFee.feeBps) : null,
    feeAmountRaw: platformFee ? BigInt(platformFee.amount) : null,
    // The exact, unmodified quote object — Jupiter's /swap (build) step
    // requires this back verbatim as `quoteResponse`, not a re-derived
    // shape, so it's kept alongside the parsed convenience fields above
    // rather than replacing them.
    raw: data
  };
}

/**
 * Fetches Jupiter's verified-tag token list — the "You receive" picker's
 * only data source this phase (see this feature's own scope-cut note:
 * no paste-a-mint-address path exists yet).
 * @returns {Promise<Array<{ address: string, symbol: string, name: string, decimals: number, logoUri: string|null }>>}
 */
export async function getVerifiedTokens() {
  const data = await fetchJupiter(JUPITER_VERIFIED_TOKENS_PATH);
  if (!Array.isArray(data)) {
    throw new Error('Jupiter returned an unexpected token-list response shape.');
  }
  return data.map(normalizeVerifiedToken).filter((t) => t.address && typeof t.decimals === 'number');
}

/**
 * Jupiter's Token API has shipped more than one response shape across its
 * versions (`address`+`logoURI` in the older v1-era list, `id`+`icon` in
 * the newer v2 one — see this file's header comment on why the v2 tag
 * endpoint's exact field names weren't independently confirmed against an
 * authoritative spec). Normalizing defensively here means a field-name
 * drift only needs a fix in one place, not everywhere this list is used.
 */
function normalizeVerifiedToken(entry) {
  const address = entry.address || entry.id;
  return {
    address,
    symbol: entry.symbol,
    // Jupiter's list names the native-SOL stand-in mint "Wrapped SOL" —
    // technically true (So111…112 IS the wSOL mint) but confusing in a
    // wallet UI where the user is swapping their NATIVE SOL (the swap
    // flow wraps/unwraps transparently, wrapAndUnwrapSol: true). Owner
    // report from the first real-money swap (prompt 0203 Revisi 3): the
    // "You receive" list showing "SOL Wrapped SOL" reads like a
    // different asset. Displayed as "Solana" instead, matching how the
    // rest of this wallet names native SOL.
    name: address === NATIVE_SOL_MINT ? 'Solana' : entry.name,
    decimals: entry.decimals,
    logoUri: entry.logoURI || entry.icon || null
  };
}

/**
 * Asks Jupiter to build an (UNSIGNED) serialized swap transaction for a
 * quote obtained from getSwapQuote() above. This is a real API call —
 * Jupiter genuinely returns a real transaction — but building one is not
 * the same as executing it: nothing here signs or broadcasts anything,
 * and this file exports no function that does (see this file's own
 * header comment). Not currently called by background.js at all this
 * phase (FLUXIO_INTERNAL_EXECUTE_SWAP rejects before reaching it) — kept
 * here, tested in isolation, so Phase 2 only has to wire it up, not write
 * it.
 * @param {object} params
 * @param {object} params.quoteResponse - the exact `raw` object getSwapQuote() returned.
 * @param {string} params.userPublicKey - the swapping wallet's base58 Solana address.
 * @param {string} [params.feeAccount] - see SWAP_FEE_ACCOUNTS' own comment; omitted entirely when no fee applies.
 * @returns {Promise<{ swapTransactionBase64: string }>}
 */
export async function buildSwapTransaction({ quoteResponse, userPublicKey, feeAccount }) {
  requireValidAddress(userPublicKey, 'User');
  if (!quoteResponse || typeof quoteResponse !== 'object' || quoteResponse.inAmount == null) {
    throw new SwapValidationError('INVALID_QUOTE', 'A valid quote response is required to build a swap transaction.');
  }

  const body = {
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol: true,
    // Capped priority fee (prompt 0206 butir 5) — see
    // SWAP_PRIORITY_FEE_CAP_LAMPORTS' own comment. Living here, in the
    // one build function both the Review preview and the Confirm execute
    // path call, is what makes the two requests structurally identical.
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: SWAP_PRIORITY_FEE_CAP_LAMPORTS,
        priorityLevel: SWAP_PRIORITY_FEE_LEVEL
      }
    }
  };
  if (feeAccount) {
    body.feeAccount = feeAccount;
  }

  const data = await fetchJupiter(JUPITER_SWAP_BUILD_PATH, { method: 'POST', body });
  if (!data.swapTransaction) {
    throw new Error('Jupiter did not return a swap transaction.');
  }
  if (data.prioritizationFeeLamports != null && Number(data.prioritizationFeeLamports) > SWAP_PRIORITY_FEE_CAP_LAMPORTS) {
    // Never observed live (the response honored the cap in every real
    // build this prompt measured) — but the "Network fee (max)" promise
    // shown to the user rests on this number, so an above-cap build is
    // refused before anything could sign it rather than trusted.
    throw new SwapValidationError(
      'SWAP_PRIORITY_FEE_ABOVE_CAP',
      `Jupiter returned a priority fee of ${data.prioritizationFeeLamports} lamports, above the requested ${SWAP_PRIORITY_FEE_CAP_LAMPORTS} cap.`
    );
  }
  return {
    swapTransactionBase64: data.swapTransaction,
    // Real numbers from the build response (prompt 0200, live-proven in
    // 0199: prioritization alone measured 56000+ lamports — far above the
    // old 5000-lamport display guess): callers surface these to the user
    // and use lastValidBlockHeight for the expiry check.
    prioritizationFeeLamports: data.prioritizationFeeLamports != null ? Number(data.prioritizationFeeLamports) : null,
    computeUnitLimit: data.computeUnitLimit != null ? Number(data.computeUnitLimit) : null,
    lastValidBlockHeight: data.lastValidBlockHeight != null ? Number(data.lastValidBlockHeight) : null
  };
}

// ---- internals ----

function requireValidMint(address, label) {
  try {
    return new PublicKey(address);
  } catch {
    throw new SwapValidationError('INVALID_MINT', `${label} mint is not a valid Solana address.`);
  }
}

function requireValidAddress(address, label) {
  try {
    return new PublicKey(address);
  } catch {
    throw new SwapValidationError('INVALID_ADDRESS', `${label} address is not a valid Solana address.`);
  }
}

function requirePositiveAmount(amountRaw) {
  let value;
  try {
    value = BigInt(amountRaw);
  } catch {
    throw new SwapValidationError('INVALID_AMOUNT', 'Amount must be a whole number of raw token units.');
  }
  if (value <= 0n) {
    throw new SwapValidationError('INVALID_AMOUNT', 'Amount must be greater than zero.');
  }
  return value;
}

function requireValidSlippageBps(slippageBps) {
  const value = Number(slippageBps);
  if (!Number.isInteger(value) || value < 1 || value > 5000) {
    throw new SwapValidationError('INVALID_SLIPPAGE', 'Slippage must be a whole number of basis points between 1 and 5000 (0.01%-50%).');
  }
  return value;
}

/** Real fetch, with a timeout and consistent error surfacing — the swap-specific sibling of @fluxio/crypto/rpc's fetchRpcWithFallback (not reused directly: that helper is shaped around a network's {rpc:{default,fallbacks}} config and JSON-RPC's {result}/{error} envelope, neither of which Jupiter's plain-REST API uses). Jupiter has no configured fallback host — same "no hosted alternative to fall back to" situation transactionService.js's own solana-local/ethereum-local entries document. */
async function fetchJupiter(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await withTimeout(
      fetch(`${JUPITER_API_BASE}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      }),
      JUPITER_FETCH_TIMEOUT_MS
    );
  } catch (err) {
    throw new Error(`Could not reach Jupiter: ${err?.message || 'unknown error'}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Jupiter returned a non-JSON response (status ${response.status}).`);
  }

  if (!response.ok || data?.error) {
    // Jupiter's own error responses (e.g. a genuinely illiquid pair —
    // "Could not find any route", errorCode COULD_NOT_FIND_ANY_ROUTE) are
    // surfaced via this same path, not treated as a transport failure.
    throw new Error(data?.error || data?.errorCode || `Jupiter request failed (status ${response.status}).`);
  }
  return data;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out.')), ms))]);
}
