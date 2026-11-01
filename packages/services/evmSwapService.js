/**
 * EVM swaps via the KyberSwap Aggregator API. Tahap A (prompt 0219) was
 * quotes only; tahap B (prompt 0220) adds the BUILD step and the
 * read-only RPC wrappers the background's execute path needs — but this
 * module STILL never signs and never broadcasts a transaction it built
 * on its own initiative: buildEvmSwapTransaction returns calldata, the
 * background runs every guard in its EXECUTE handler, signing happens
 * through walletService's existing EVM signer (the exact same boundary
 * sendEthTransfer uses), and sendEvmRawTransaction only ever relays a
 * fully signed raw transaction handed to it.
 *
 * Why KyberSwap, and why these exact shapes: the 0218 read-only spike
 * (prompt/evidence/0218-evm-swap-spike/) probed four aggregators live on
 * BNB Chain; only KyberSwap was reachable (HTTP 200 with no key — the
 * X-Client-Id header is a free-form identifier, not a registered key),
 * its CORS reflects the extension origin exactly, and its two-way
 * raw-wei quotes reconciled within 0,33% of both CoinGecko and
 * PancakeSwap on-chain (Router V2 + QuoterV2 fee tier 100). The owner
 * locked KyberSwap as the primary aggregator in 0218 Revisi 1.
 *
 * Why there is NO Fluxio fee here yet (owner keputusan 0218: opsi A):
 * an EVM fee needs an EVM treasury address, which does not exist and is
 * its own future decision. EVM_SWAP_FEE_OPTIONS below is the frozen,
 * empty slot where Kyber's own fee parameters (feeAmount, chargeFeeBy,
 * isInBps, feeReceiver — see docs.kyberswap.com) will plug in later
 * WITHOUT changing this module's function signatures or the callers.
 *
 * The returned `routeSummary` is the UNTOUCHED object from Kyber's
 * response (owner keputusan 0219: stored as-is per quoteId — Kyber's
 * build endpoint validates a checksum over its contents, so any
 * reshaping here would break tahap B's POST /route/build, which requires
 * the routeSummary exactly "as per returned from Get Swap Route" plus a
 * slippageTolerance in bps [0, 2000]).
 *
 * Like transactionService/evmTransactionService, this module NEVER
 * imports walletService and never sees a seed; tahap B's signing will be
 * an injected callback, same boundary as every money path in this repo.
 */
import { NETWORKS, getEvmTipFloorWei } from '@fluxio/constants';
import { fetchRpcWithFallback } from '@fluxio/crypto/rpc';

export const KYBER_API_BASE = 'https://aggregator-api.kyberswap.com';

/**
 * networkKey -> KyberSwap chain slug — the ONE structural gate every EVM
 * swap network passes through (requireChainSlug below refuses anything
 * else). BNB Chain shipped in 0219 (owner keputusan 0218); ethereum and
 * base joined in 0227 per owner keputusan 0225 K1 — both slugs proven
 * LIVE in the 0225 spike (HTTP 200 quotes + builds, the SAME router
 * 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5 as BNB, fee echo identical;
 * prompt/evidence/0225-evm-swap-spike-eth-base/).
 */
export const KYBER_CHAIN_SLUGS = Object.freeze({ bnb: 'bsc', ethereum: 'ethereum', base: 'base' });

/** The one derived list every gate reads (0225 K1): background's four networkKey gates and the popup's own copy (shared/swapNetworks.js, locked equal by unit test) both follow this — adding a network is this map plus its caps/reserves rows. */
export const EVM_SWAP_NETWORK_KEYS = Object.freeze(Object.keys(KYBER_CHAIN_SLUGS));

/** @returns {boolean} true when `key` is an EVM network this swap feature serves (0225 K1 — replaces every `networkKey === 'bnb'` gate). */
export function isEvmSwapNetwork(key) {
  return Object.prototype.hasOwnProperty.call(KYBER_CHAIN_SLUGS, key);
}

/** Kyber's sentinel for the NATIVE coin (docs.kyberswap.com, verified live in the 0218 spike — responses echo it lowercase). */
export const NATIVE_EVM_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/** Free-form client identifier (NOT an API key — docs: "Provide a value to identify your client and avoid getting rate limited"). Owner keputusan 0218 Revisi 1 / 0219 opsi (v). */
export const EVM_SWAP_CLIENT_ID = 'fluxio-wallet';

/**
 * Emergency build switch, same role as Solana's SWAP_EXECUTION_ENABLED:
 * ships true since tahap B (prompt 0220, owner approved). Direction is a
 * SEPARATE gate in the background's EXECUTE handler against the cached
 * quote's own inputRef/outputRef: native-in (0220) and token-in to
 * native out (tahap C, 0223 — with the staged approve flow) execute on
 * every EVM_SWAP_NETWORK_KEYS network since 0227; token to token stays
 * refused with honest coming-soon text.
 */
export const EVM_SWAP_EXECUTION_ENABLED = true;

/**
 * Hard caps PER NETWORK (owner keputusan 0220 opsi A1 for bnb; 0225 K2
 * for ethereum/base) — frozen; an execute above either cap is REJECTED
 * before signing. The old single-network constants
 * (EVM_SWAP_GAS_LIMIT_CAP / EVM_SWAP_MAX_FEE_PER_GAS_CAP) are DELETED,
 * not aliased — every caller goes through getEvmSwapCaps(networkKey) so
 * an unknown network can never silently inherit another network's caps.
 *
 * Why the caps differ (0225 spike, measured): BNB's tip is a flat 0,05
 * gwei with baseFee 0, so 3 gwei is already 60x headroom; Ethereum's
 * baseFee moves fast (0,058 -> 0,26 gwei within hours on 20 Oktober) and
 * its SIMPLEST measured route quoted 588.427 gas — x2 of that would
 * breach a 1M gas cap, hence 2M; Base sits at ~0,011 gwei with light
 * routes, so 0,5 gwei + 1,5M is still wide.
 *
 * Worst-case fee loss table (gas cap x fee cap; BNB at $733,8 — 0220's
 * archived read; ETH at $2.407 — the 0225 spike's archived CoinGecko):
 *   bnb      1.000.000 x 3 gwei   = 0,003 BNB    ~ $2,20
 *   ethereum 2.000.000 x 10 gwei  = 0,02 ETH     ~ $48,14
 *   base     1.500.000 x 0,5 gwei = 0,00075 ETH  ~ $1,81
 */
export const EVM_SWAP_GAS_LIMIT_CAP_BY_NETWORK = Object.freeze({
  bnb: 1000000n,
  ethereum: 2000000n,
  base: 1500000n
});
export const EVM_SWAP_MAX_FEE_PER_GAS_CAP_BY_NETWORK = Object.freeze({
  bnb: 3000000000n, // 3 gwei (BSC standard tip is 0,05 gwei — 0213-proven)
  ethereum: 10000000000n, // 10 gwei (0225 K2 — measured maxFee 0,12 to 0,26 gwei)
  base: 500000000n // 0,5 gwei (0225 K2 — measured maxFee 0,011 gwei, stable)
});

/** @returns {{ gasLimitCap: bigint, maxFeePerGasCap: bigint }} this network's hard caps; an unknown key THROWS (never a silent default — 0225 K2). */
export function getEvmSwapCaps(networkKey) {
  const gasLimitCap = EVM_SWAP_GAS_LIMIT_CAP_BY_NETWORK[networkKey];
  const maxFeePerGasCap = EVM_SWAP_MAX_FEE_PER_GAS_CAP_BY_NETWORK[networkKey];
  if (gasLimitCap == null || maxFeePerGasCap == null) {
    throw new EvmSwapValidationError('SWAP_NETWORK_UNSUPPORTED', `No swap fee caps are configured for network "${networkKey}".`);
  }
  return { gasLimitCap, maxFeePerGasCap };
}

/**
 * networkKey -> CoinGecko id of the NATIVE coin, for the USD sanity guard
 * (0225 K4). Mirrors shared/portfolioValue.js's own NATIVE_COIN_IDS for
 * these networks (ethereum and base are both plain ETH; bnb is
 * 'binancecoin') — kept here too because this package cannot import the
 * extension's shared/ modules.
 */
export const EVM_SWAP_NATIVE_COIN_IDS = Object.freeze({ bnb: 'binancecoin', ethereum: 'ethereum', base: 'ethereum' });

/**
 * Re-broadcast pacing + the honest-pending window (owner keputusan 0220
 * opsi B1): identical signed bytes are re-sent every 15 seconds (same
 * hash, the chain executes at most one — swap lesson 1 in EVM form)
 * until a receipt exists or 10 minutes pass; past the window the verdict
 * is an HONEST PENDING (EVM has no blockhash expiry — the tx can still
 * land), never a failure.
 */
export const EVM_SWAP_REBROADCAST_INTERVAL_MS = 15000;
export const EVM_SWAP_PENDING_TIMEOUT_MS = 600000;

/**
 * Quote sanity guard (owner keputusan 0220 butir 5, a guard Solana does
 * not have yet): the fresh quote's own USD legs (via the portfolio price
 * cache, only when younger than EVM_SWAP_SANITY_PRICE_MAX_AGE_MS; absent
 * or stale prices SKIP the check without failing) must not deviate more
 * than 5% — beyond it the execute refuses with EVM_SWAP_QUOTE_SUSPICIOUS
 * and nothing is signed.
 */
export const EVM_SWAP_SANITY_MAX_DEVIATION = 0.05;
export const EVM_SWAP_SANITY_PRICE_MAX_AGE_MS = 30000;

/**
 * The EVM treasury (prompt 0221, FAKTA PEMILIK 15 Oktober 2026 — never
 * guessed or substituted): the owner's own wallet, NOT the test wallet
 * and NOT an exchange deposit address. Verified in 0221 fase 1:
 * ethers.getAddress returns this exact string (checksum valid),
 * eth_getCode is 0x on two endpoints (an EOA), and baselines read
 * 0 BNB / 0 USDT / 0 WBNB at adoption time. Locked by unit test
 * (checksum identity + not the test address).
 */
export const EVM_SWAP_FEE_RECEIVER = '0xE374bd0c7FA83C726BEdC1f99e37737002bca310';

/**
 * The Fluxio fee on BNB Chain swaps (prompt 0221, owner keputusan 15
 * Oktober 2026): 85 bps = 0,85%, the same rate as Solana, on EVERY pair
 * (EVM has no per-mint fee-account constraint the way Jupiter does),
 * charged from the PAY side. Parameter names and semantics are Kyber's
 * own (docs.kyberswap.com evm-swaps spec, fetched live 15 Oktober 2026):
 * `feeAmount` with `isInBps` true is "the percentage of fees to take
 * with base unit = 10000", `chargeFeeBy` currency_in charges the input
 * token, `feeReceiver` is "The API client's wallet address(es) to
 * receive fee". getEvmSwapQuote forwards all four on every quote, and
 * the quote's own routeSummary.extraFee must echo them back — enforced
 * pre-sign by verifyEvmFeeEcho (pagar b2).
 */
export const EVM_SWAP_FEE_OPTIONS = Object.freeze({
  feeAmount: 85,
  chargeFeeBy: 'currency_in',
  isInBps: true,
  feeReceiver: EVM_SWAP_FEE_RECEIVER
});

const QUOTE_TIMEOUT_MS = 8000;

export class EvmSwapValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EvmSwapValidationError';
    this.code = code;
  }
}

function requireChainSlug(networkKey) {
  const slug = KYBER_CHAIN_SLUGS[networkKey];
  if (!slug) {
    throw new EvmSwapValidationError(
      'SWAP_NETWORK_UNSUPPORTED',
      `Swap quotes are not available for network "${networkKey}".`
    );
  }
  if (!NETWORKS[networkKey] || NETWORKS[networkKey].isTestnet !== false) {
    throw new EvmSwapValidationError('SWAP_NETWORK_UNSUPPORTED', 'EVM swap quotes are mainnet only.');
  }
  return slug;
}

function requireTokenRef(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new EvmSwapValidationError('INVALID_TOKEN', `${label} is required.`);
  }
  if (value === NATIVE_EVM_SENTINEL) return value;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new EvmSwapValidationError('INVALID_TOKEN', `${label} is not a valid token address.`);
  }
  return value;
}

/**
 * One live KyberSwap quote (GET /{slug}/api/v1/routes). Read-only; sends
 * token contract addresses, the raw amount, the client id and the STATIC
 * Fluxio fee parameters (0221 — the treasury's own public address, never
 * the USER's wallet address; that still only happens at build time).
 * Field paths match the archived 0218/0221 fixtures exactly
 * (data.routeSummary.*, data.routerAddress); amounts are raw-wei strings
 * parsed as BigInt.
 *
 * @param {object} params
 * @param {string} params.networkKey - any EVM_SWAP_NETWORK_KEYS member ('bnb' since 0219; 'ethereum'/'base' since 0227 per 0225 K1).
 * @param {string} params.tokenIn - 0x address, or NATIVE_EVM_SENTINEL.
 * @param {string} params.tokenOut - 0x address, or NATIVE_EVM_SENTINEL.
 * @param {bigint|string} params.amountInRaw - raw wei, > 0.
 * @returns {Promise<{
 *   amountInRaw: bigint, amountOutRaw: bigint, gasEstimate: bigint,
 *   routerAddress: string, routeSummary: object,
 *   amountInUsd: string|null, amountOutUsd: string|null
 * }>}
 */
export async function getEvmSwapQuote({ networkKey, tokenIn, tokenOut, amountInRaw }) {
  const slug = requireChainSlug(networkKey);
  const tin = requireTokenRef(tokenIn, 'tokenIn');
  const tout = requireTokenRef(tokenOut, 'tokenOut');
  if (tin.toLowerCase() === tout.toLowerCase()) {
    throw new EvmSwapValidationError('INVALID_TOKEN', 'tokenIn and tokenOut must differ.');
  }
  let amount;
  try {
    amount = BigInt(amountInRaw);
  } catch {
    throw new EvmSwapValidationError('INVALID_AMOUNT', 'amountInRaw must be a raw integer amount.');
  }
  if (amount <= 0n) {
    throw new EvmSwapValidationError('INVALID_AMOUNT', 'Amount must be greater than 0.');
  }

  // The Fluxio fee rides on EVERY quote since 0221 (owner keputusan):
  // Kyber applies it inside the route, echoes it in
  // routeSummary.extraFee, and the build charges it in-router — the
  // transactionValue stays the FULL amountIn (0221 fase 1, live-proven).
  const feeParams = new URLSearchParams({
    feeAmount: String(EVM_SWAP_FEE_OPTIONS.feeAmount),
    chargeFeeBy: EVM_SWAP_FEE_OPTIONS.chargeFeeBy,
    isInBps: String(EVM_SWAP_FEE_OPTIONS.isInBps),
    feeReceiver: EVM_SWAP_FEE_OPTIONS.feeReceiver
  });
  const url = `${KYBER_API_BASE}/${slug}/api/v1/routes?tokenIn=${tin}&tokenOut=${tout}&amountIn=${amount}&${feeParams.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUOTE_TIMEOUT_MS);
  let payload;
  try {
    const response = await fetch(url, {
      headers: { 'X-Client-Id': EVM_SWAP_CLIENT_ID },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new EvmSwapValidationError('SWAP_QUOTE_FAILED', `Quote request failed (HTTP ${response.status}).`);
    }
    payload = await response.json();
  } catch (error) {
    if (error instanceof EvmSwapValidationError) throw error;
    if (error && error.name === 'AbortError') {
      throw new EvmSwapValidationError('SWAP_QUOTE_TIMEOUT', 'Quote request timed out.');
    }
    throw new EvmSwapValidationError('SWAP_QUOTE_FAILED', 'Could not reach the swap quote service.');
  } finally {
    clearTimeout(timer);
  }

  const summary = payload?.data?.routeSummary;
  const routerAddress = payload?.data?.routerAddress;
  if (!summary || typeof routerAddress !== 'string' || !routerAddress) {
    throw new EvmSwapValidationError('SWAP_QUOTE_FAILED', 'Quote response was missing route data.');
  }
  let amountOutRaw, gasEstimate;
  try {
    amountOutRaw = BigInt(summary.amountOut);
    gasEstimate = BigInt(summary.gas);
  } catch {
    throw new EvmSwapValidationError('SWAP_QUOTE_FAILED', 'Quote response carried a malformed amount.');
  }
  if (amountOutRaw <= 0n) {
    throw new EvmSwapValidationError('SWAP_QUOTE_FAILED', 'Quote returned a zero output amount.');
  }

  return {
    amountInRaw: amount,
    amountOutRaw,
    gasEstimate,
    routerAddress,
    // UNTOUCHED, by owner decision — see the header comment (checksum).
    routeSummary: summary,
    amountInUsd: typeof summary.amountInUsd === 'string' ? summary.amountInUsd : null,
    amountOutUsd: typeof summary.amountOutUsd === 'string' ? summary.amountOutUsd : null
  };
}

/**
 * Display-only fee ceiling for tahap A's Review screen, mirroring the
 * Send flow's own 0213-proven math (evmTransactionService.js
 * estimateFeePerGas + the 12n/10n gas buffer): maxFeePerGas = baseFee ×
 * 2 + tip (on BSC baseFee is 0 so this equals the flat 0,05 gwei tip and
 * the real fee equals the bound; on Ethereum/Base baseFee MOVES — 0225/
 * 0226 measured — so the real fee lands below this ceiling and the
 * reservation residual stays in the wallet), gasLimit =
 * floor(gasEstimate × 1,2). Nothing here
 * broadcasts; the number is the same upper bound the Send screen's "Max
 * network fee" shows.
 * @returns {Promise<{ gasLimit: bigint, maxFeePerGas: bigint, maxFeeWei: bigint }>}
 */
export async function estimateEvmSwapFeeWei({ networkKey, gasEstimate }) {
  requireChainSlug(networkKey);
  let gas;
  try {
    gas = BigInt(gasEstimate);
  } catch {
    throw new EvmSwapValidationError('INVALID_AMOUNT', 'gasEstimate must be an integer.');
  }
  if (gas <= 0n) {
    throw new EvmSwapValidationError('INVALID_AMOUNT', 'gasEstimate must be greater than 0.');
  }
  // 0231: ONE fee source. This used to duplicate the baseFee x 2 + tip
  // formula (0219), which would have silently skipped the tip floor here
  // — caught by the 0231 e2e, not by review: the PREVIEW ceiling is what
  // the cutter enforces, so a floorless ceiling would make EXECUTE sign
  // below the floor on exactly the tip 0 days the floor exists for.
  const { maxFeePerGas } = await getEvmFeePerGas({ networkKey });
  const gasLimit = (gas * 12n) / 10n;
  return { gasLimit, maxFeePerGas, maxFeeWei: gasLimit * maxFeePerGas };
}

/**
 * Live EIP-1559 fee parameters for an execute (same math as the display
 * estimate above and as evmTransactionService's own estimateFeePerGas:
 * maxFeePerGas = baseFee x 2 + tip — 0213-proven on BSC where baseFee is
 * 0 so the real fee equals the bound; on Ethereum/Base the moving baseFee
 * keeps the real fee below it, 0226-proven).
 * @returns {Promise<{ maxFeePerGas: bigint, maxPriorityFeePerGas: bigint, baseFeePerGas: bigint, tipFloorApplied: boolean }>}
 */
/**
 * Latest block number (0232 Revisi 3): the received resolver on an
 * op-stack network must know how old a receipt is before trusting its
 * l1Fee field — a seconds-old Base receipt was proven to carry a non
 * canonical l1Fee (22.257.870.609 vs the canonical 99.847.647.673).
 * @returns {Promise<bigint>}
 */
export async function getEvmBlockNumber({ networkKey }) {
  requireChainSlug(networkKey);
  const network = NETWORKS[networkKey];
  const res = await fetchRpcWithFallback(network, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
  return BigInt(res.result);
}

export async function getEvmFeePerGas({ networkKey }) {
  requireChainSlug(networkKey);
  const network = NETWORKS[networkKey];
  const [blockResult, tipResult] = await Promise.all([
    fetchRpcWithFallback(network, { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }),
    fetchRpcWithFallback(network, { jsonrpc: '2.0', id: 1, method: 'eth_maxPriorityFeePerGas', params: [] })
  ]);
  const baseFeeHex = blockResult?.result?.baseFeePerGas;
  const baseFee = baseFeeHex ? BigInt(baseFeeHex) : 0n;
  const endpointTip = tipResult?.result ? BigInt(tipResult.result) : 1500000000n;
  // Tip floor (prompt 0231, owner approved): a public endpoint can answer
  // eth_maxPriorityFeePerGas with ~0 (0228 R3: both legs signed tip 0 and
  // took 3 blocks; measured 22 Oktober: 3.839 wei vs real p50 ~0.096 gwei
  // on Ethereum), and a 0 tip tx can hang in a busy mempool until the
  // continuation window halts. Effective tip = max(endpoint, floor); the
  // per network maxFeePerGas caps downstream still win unchanged.
  const tipFloorWei = getEvmTipFloorWei(networkKey);
  const tipFloorApplied = endpointTip < tipFloorWei;
  const maxPriorityFeePerGas = tipFloorApplied ? tipFloorWei : endpointTip;
  // baseFeePerGas rides along since 0227 Revisi 1: pickSignedMaxFeePerGas
  // needs the inclusion floor (baseFee + tip) to judge whether a ceiling
  // cut maxFeePerGas can still land in a block.
  return { maxFeePerGas: baseFee * 2n + maxPriorityFeePerGas, maxPriorityFeePerGas, baseFeePerGas: baseFee, tipFloorApplied };
}

/**
 * 0227 Revisi 1 (owner opsi 1 — pelajaran swap 10 ditegakkan secara
 * KONSTRUKTIF): the maxFeePerGas actually SIGNED at every EVM swap sign
 * point is min(fresh maxFeePerGas, floor(displayed ceiling / fresh
 * gasLimit)), so the user never pays above the number they saw — and a
 * small baseFee wobble (or Kyber's quote gas undershooting the real
 * eth_estimateGas, the mechanism fase 1 PROVED on Base: quote gas 330.498
 * vs real 402.727) no longer bounces every Confirm back as
 * EVM_SWAP_FEE_ABOVE_DISPLAYED. The cut value must still be able to land
 * in a block: below the fresh inclusion floor (baseFee + tip) the picker
 * returns null and the caller refuses exactly as before (the gas-truly-
 * rose case). A null/absent ceiling (PREVIEW never answered) keeps the
 * fresh fee — nothing was displayed to guarantee.
 * @returns {bigint|null} the maxFeePerGas to sign, or null to refuse.
 */
export function pickSignedMaxFeePerGas({ freshMaxFeePerGas, baseFeePerGas, maxPriorityFeePerGas, gasLimit, displayedMaxFeeWei }) {
  let fresh, base, tip, gas, ceiling;
  try {
    fresh = BigInt(freshMaxFeePerGas);
    base = BigInt(baseFeePerGas);
    tip = BigInt(maxPriorityFeePerGas);
    gas = BigInt(gasLimit);
    ceiling = displayedMaxFeeWei == null ? null : BigInt(displayedMaxFeeWei);
  } catch {
    return null; // malformed input fails CLOSED, never signs a guess
  }
  if (gas <= 0n || fresh <= 0n) return null;
  if (ceiling == null) return fresh;
  const cap = ceiling / gas; // floor
  const candidate = fresh < cap ? fresh : cap;
  const inclusionFloor = base + tip;
  if (candidate < inclusionFloor) return null;
  return candidate;
}

/**
 * Op-stack L1 data fee oracle predeploys, per network (0227 Revisi 1 K2).
 * Detection is BY CONSTANT, never by trying the call: only networks
 * listed here ever get an oracle request. Base's GasPriceOracle was
 * chain-proven in 0226 (eth_getCode 2.055 bytes) and its getL1Fee output
 * reconciled against the real 0226 send receipt's own l1Fee field.
 */
export const EVM_L1_FEE_ORACLE_BY_NETWORK = Object.freeze({
  base: '0x420000000000000000000000000000000000000F'
});

// ---- Minimal RLP (type-2 sample tx for getL1Fee — only the byte SIZE
// matters to the oracle, so a dummy signature is fine; nothing here is
// ever signed for real or broadcast). ---------------------------------
function rlpIntBytes(n) {
  let v = BigInt(n);
  if (v === 0n) return [];
  const out = [];
  while (v > 0n) {
    out.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return out;
}
function rlpHexBytes(hex) {
  const h = hex.replace(/^0x/, '');
  const out = [];
  for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
}
function rlpLengthPrefix(len, offset) {
  if (len < 56) return [offset + len];
  const lb = rlpIntBytes(len);
  return [offset + 55 + lb.length, ...lb];
}
function rlpEncodeItem(b) {
  if (b.length === 1 && b[0] < 0x80) return b;
  return [...rlpLengthPrefix(b.length, 0x80), ...b];
}
function rlpEncodeList(items) {
  const payload = items.flat();
  return [...rlpLengthPrefix(payload.length, 0xc0), ...payload];
}

/**
 * Serialized SIGNED-SHAPE type-2 tx bytes (dummy signature) carrying the
 * REAL calldata — the input getL1Fee prices. Pure; exported for tests.
 * @returns {Uint8Array}
 */
export function serializeSampleType2Tx({ chainId, gasLimit, maxFeePerGas, to, valueRaw, calldata }) {
  const items = [
    rlpEncodeItem(rlpIntBytes(chainId)),
    rlpEncodeItem(rlpIntBytes(1)), // nonce placeholder
    rlpEncodeItem(rlpIntBytes(maxFeePerGas)), // tip placeholder (size-equivalent)
    rlpEncodeItem(rlpIntBytes(maxFeePerGas)),
    rlpEncodeItem(rlpIntBytes(gasLimit)),
    rlpEncodeItem(rlpHexBytes(to)),
    rlpEncodeItem(rlpIntBytes(valueRaw)),
    rlpEncodeItem(rlpHexBytes(calldata)),
    rlpEncodeList([]), // accessList
    rlpEncodeItem(rlpIntBytes(1)), // yParity
    rlpEncodeItem(rlpHexBytes('11'.repeat(32))), // r dummy
    rlpEncodeItem(rlpHexBytes('22'.repeat(32))) // s dummy
  ];
  return Uint8Array.from([0x02, ...rlpEncodeList(items)]);
}

const L1_FEE_SELECTOR = '0x49948e0e'; // getL1Fee(bytes)

/**
 * Estimated op-stack L1 data fee for a swap-shaped tx (0227 Revisi 1 K2):
 * eth_call GasPriceOracle.getL1Fee over the REAL build calldata wrapped
 * in a sample type-2 tx. Returns null for a network without an oracle
 * constant (no trial call is ever made — ethereum/bnb never touch this),
 * and null on ANY failure: the caller then shows the ceiling WITHOUT the
 * l1 component and logs it (owner's explicit choice — the x1,2 gas
 * headroom usually covers the small l1 fee; fase 1 measured it at 0,26%
 * of the ceiling), rather than blocking the preview.
 * @returns {Promise<bigint|null>}
 */
export async function estimateL1FeeWei({ networkKey, calldata, gasLimit, maxFeePerGas, to, valueRaw }) {
  const oracle = EVM_L1_FEE_ORACLE_BY_NETWORK[networkKey];
  if (!oracle) return null;
  try {
    const network = NETWORKS[networkKey];
    const tx = serializeSampleType2Tx({ chainId: network.chainId, gasLimit, maxFeePerGas, to, valueRaw, calldata });
    let dataHex = '';
    for (const b of tx) dataHex += b.toString(16).padStart(2, '0');
    const lenWord = BigInt(tx.length).toString(16).padStart(64, '0');
    const padded = dataHex + '0'.repeat((64 - (dataHex.length % 64)) % 64);
    const callData = L1_FEE_SELECTOR + '20'.padStart(64, '0') + lenWord + padded;
    const result = await fetchRpcWithFallback(network, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: oracle, data: callData }, 'latest'] });
    if (!result?.result || result.result === '0x') return null;
    return BigInt(result.result);
  } catch {
    return null;
  }
}

/**
 * KyberSwap build (POST /{slug}/api/v1/route/build, tahap B — prompt
 * 0220): turns a FRESH quote's untouched routeSummary into router
 * calldata. This is the one call that carries the user's PUBLIC wallet
 * address (sender = recipient), the same disclosure boundary Jupiter's
 * build has had since 0200 — Privacy.jsx documents it. Docs (the
 * OpenAPI spec at docs.kyberswap.com, quoted in the 0220 archive):
 * required routeSummary/sender/recipient; slippageTolerance in bps
 * [0, 2000]; deadline defaults to +20 minutes server-side. Response
 * fields used: data.data (calldata), data.routerAddress,
 * data.transactionValue ("Transaction value to send to router for swaps
 * from native tokens"), data.amountIn/amountOut/gas.
 * @returns {Promise<{
 *   calldata: string, routerAddress: string, transactionValueRaw: bigint,
 *   amountInRaw: bigint, amountOutRaw: bigint, gasRaw: bigint
 * }>}
 */
export async function buildEvmSwapTransaction({ networkKey, routeSummary, sender, recipient, slippageBps }) {
  const slug = requireChainSlug(networkKey);
  if (!routeSummary || typeof routeSummary !== 'object') {
    throw new EvmSwapValidationError('EVM_SWAP_BUILD_FAILED', 'A fresh routeSummary is required to build the swap.');
  }
  for (const [label, value] of [['sender', sender], ['recipient', recipient]]) {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new EvmSwapValidationError('EVM_SWAP_BUILD_FAILED', `${label} must be a valid address.`);
    }
  }
  const slippage = Number(slippageBps);
  if (!Number.isInteger(slippage) || slippage < 0 || slippage > 2000) {
    // Kyber's own documented range for slippageTolerance.
    throw new EvmSwapValidationError('EVM_SWAP_BUILD_FAILED', 'slippageBps must be an integer in [0, 2000].');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUOTE_TIMEOUT_MS);
  let payload;
  try {
    const response = await fetch(`${KYBER_API_BASE}/${slug}/api/v1/route/build`, {
      method: 'POST',
      headers: { 'X-Client-Id': EVM_SWAP_CLIENT_ID, 'content-type': 'application/json' },
      body: JSON.stringify({ routeSummary, sender, recipient, slippageTolerance: slippage }),
      signal: controller.signal
    });
    payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.code !== 0) {
      const code = payload?.code != null ? ` (code ${payload.code})` : ` (HTTP ${response.status})`;
      throw new EvmSwapValidationError('EVM_SWAP_BUILD_FAILED', `Could not build the swap${code}: ${payload?.message || 'no detail'}.`);
    }
  } catch (error) {
    if (error instanceof EvmSwapValidationError) throw error;
    if (error && error.name === 'AbortError') {
      throw new EvmSwapValidationError('EVM_SWAP_BUILD_FAILED', 'Build request timed out.');
    }
    throw new EvmSwapValidationError('EVM_SWAP_BUILD_FAILED', 'Could not reach the swap build service.');
  } finally {
    clearTimeout(timer);
  }

  const d = payload.data || {};
  if (typeof d.data !== 'string' || !d.data.startsWith('0x') || d.data.length <= 2) {
    throw new EvmSwapValidationError('EVM_SWAP_BUILD_FAILED', 'Build response carried no calldata.');
  }
  let transactionValueRaw, amountInRaw, amountOutRaw, gasRaw;
  try {
    transactionValueRaw = BigInt(d.transactionValue ?? 0);
    amountInRaw = BigInt(d.amountIn);
    amountOutRaw = BigInt(d.amountOut);
    gasRaw = BigInt(d.gas);
  } catch {
    throw new EvmSwapValidationError('EVM_SWAP_BUILD_FAILED', 'Build response carried a malformed amount.');
  }
  if (typeof d.routerAddress !== 'string' || !d.routerAddress) {
    throw new EvmSwapValidationError('EVM_SWAP_BUILD_FAILED', 'Build response carried no router address.');
  }
  return { calldata: d.data, routerAddress: d.routerAddress, transactionValueRaw, amountInRaw, amountOutRaw, gasRaw };
}

/**
 * Pagar (d), pure (prompt 0220 KONTEKS 5d, unit-tested against the real
 * archived build fixtures): the build's own figures must match what the
 * FRESH quote displayed, or nothing gets signed. Every check throws its
 * own structured error; passing returns nothing.
 */
export function verifyEvmSwapBuild({ build, expectedRouterAddress, expectedAmountInRaw, expectedValueRaw, freshAmountOutRaw, chainId, expectedChainId }) {
  if (chainId !== expectedChainId) {
    throw new EvmSwapValidationError('EVM_SWAP_BUILD_MISMATCH', `Network chain id ${chainId} is not the expected ${expectedChainId}.`);
  }
  if (!build || typeof build.calldata !== 'string' || build.calldata.length <= 2) {
    throw new EvmSwapValidationError('EVM_SWAP_BUILD_MISMATCH', 'The build carried no calldata.');
  }
  if (build.routerAddress.toLowerCase() !== String(expectedRouterAddress).toLowerCase()) {
    throw new EvmSwapValidationError('EVM_SWAP_BUILD_MISMATCH', 'The build router address does not match the quote router address.');
  }
  if (build.amountInRaw !== BigInt(expectedAmountInRaw)) {
    throw new EvmSwapValidationError('EVM_SWAP_BUILD_MISMATCH', 'The build amount in does not match the quote.');
  }
  if (build.transactionValueRaw !== BigInt(expectedValueRaw)) {
    throw new EvmSwapValidationError('EVM_SWAP_BUILD_MISMATCH', 'The build transaction value does not match the swap amount.');
  }
  // Within 0,1% of the fresh quote (same silent-continue band the
  // re-quote gate uses) — BigInt, no floats. The live fixtures show the
  // build echoing the quote minus at most 1 raw unit (Kyber's own
  // rounding), far inside this band.
  if (build.amountOutRaw * 1000n < BigInt(freshAmountOutRaw) * 999n) {
    throw new EvmSwapValidationError('EVM_SWAP_BUILD_MISMATCH', 'The build output amount dropped below the quoted amount.');
  }
}

/**
 * Read-only pre-sign simulation (pagar f): eth_estimateGas with the exact
 * from/to/value/data the signed tx would carry. fetchRpcWithFallback
 * itself throws on a JSON-RPC `{ error }` body (a revert) AND on
 * transport failure — both map to EVM_SWAP_SIMULATION_FAILED here,
 * carrying the node's own message: either way nothing may be signed.
 */
export async function estimateEvmGas({ networkKey, from, to, valueRaw, data }) {
  requireChainSlug(networkKey);
  const network = NETWORKS[networkKey];
  let result;
  try {
    result = await fetchRpcWithFallback(network, {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_estimateGas',
      params: [{ from, to, value: '0x' + BigInt(valueRaw).toString(16), data }]
    });
  } catch (error) {
    throw new EvmSwapValidationError('EVM_SWAP_SIMULATION_FAILED', `Simulation failed: ${error?.message || 'unknown error'}`);
  }
  if (!result?.result) {
    throw new EvmSwapValidationError('EVM_SWAP_SIMULATION_FAILED', 'Simulation returned no gas estimate.');
  }
  return BigInt(result.result);
}

/** Pending-inclusive nonce (pagar h) — the same semantics sendEthTransfer's own getNonce uses. */
export async function getEvmTransactionCount({ networkKey, address }) {
  requireChainSlug(networkKey);
  const network = NETWORKS[networkKey];
  let result;
  try {
    result = await fetchRpcWithFallback(network, {
      jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [address, 'pending']
    });
  } catch (error) {
    throw new EvmSwapValidationError('EVM_SWAP_SEND_FAILED', `Could not fetch the account nonce: ${error?.message || 'unknown error'}`);
  }
  if (!result?.result) {
    throw new EvmSwapValidationError('EVM_SWAP_SEND_FAILED', 'Could not fetch the account nonce.');
  }
  return Number(BigInt(result.result));
}

/** Relay of an ALREADY SIGNED raw transaction (this module never signs). Returns the transaction hash the node reports; a node rejection (an "already known" re-send included) surfaces as EVM_SWAP_SEND_FAILED with the node's own message. */
export async function sendEvmRawTransaction({ networkKey, signedRawTx }) {
  requireChainSlug(networkKey);
  if (typeof signedRawTx !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signedRawTx)) {
    throw new EvmSwapValidationError('EVM_SWAP_SEND_FAILED', 'A signed raw transaction hex string is required.');
  }
  const network = NETWORKS[networkKey];
  let result;
  try {
    result = await fetchRpcWithFallback(network, {
      jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [signedRawTx]
    });
  } catch (error) {
    throw new EvmSwapValidationError('EVM_SWAP_SEND_FAILED', `Broadcast rejected: ${error?.message || 'unknown error'}`);
  }
  if (!result?.result) {
    throw new EvmSwapValidationError('EVM_SWAP_SEND_FAILED', 'Broadcast returned no transaction hash.');
  }
  return result.result;
}

/** Raw receipt (or null while pending) — the verdict + the Transfer logs the real-received parser reads. */
export async function getEvmTransactionReceipt({ networkKey, hash }) {
  requireChainSlug(networkKey);
  const network = NETWORKS[networkKey];
  const result = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash]
  });
  return result?.result ?? null;
}

const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Pure real-received parser (prompt 0220, pola parseSwapReceivedRaw):
 * sums every ERC-20 Transfer log in the receipt whose contract is the
 * output token and whose `to` topic is the recipient — a routed swap can
 * legally split the output across several transfers. Returns the raw sum
 * as a decimal string, or null when no matching log exists (then the
 * quote's estimate keeps showing, labeled est., exactly like Solana).
 * Shape proven against the REAL 0213 receipt log (address = the USDT
 * contract, topics[0] = the Transfer signature, topics[2] = the padded
 * recipient, data = the raw value hex).
 */
export function parseErc20ReceivedFromReceipt({ receipt, tokenAddress, recipient }) {
  const logs = receipt?.logs;
  if (!Array.isArray(logs) || typeof tokenAddress !== 'string' || typeof recipient !== 'string') return null;
  const token = tokenAddress.toLowerCase();
  const paddedRecipient = '0x' + recipient.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  let total = null;
  for (const log of logs) {
    if (!log || typeof log.address !== 'string' || !Array.isArray(log.topics)) continue;
    if (log.address.toLowerCase() !== token) continue;
    if (log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    if (String(log.topics[2] || '').toLowerCase() !== paddedRecipient) continue;
    try {
      total = (total ?? 0n) + BigInt(log.data);
    } catch {
      return null; // a malformed value makes the whole parse untrustworthy
    }
  }
  return total != null ? total.toString() : null;
}

/**
 * Pagar (b2), pure (prompt 0221, owner keputusan 4): the FRESH quote's
 * routeSummary.extraFee must echo OUR fee parameters exactly, or nothing
 * gets signed — a quote Kyber served without the fee would charge the
 * user the displayed fee row for nothing (or skip the treasury fee
 * silently). Comparison rules are the owner's own, from the live echo
 * proven in 0221 fase 1: feeReceiver case-insensitive (Kyber echoes it
 * LOWERCASE), feeAmount must match BOTH as the string '85' AND as the
 * number 85, isInBps strictly true, chargeFeeBy strictly 'currency_in'.
 * Throws EVM_SWAP_FEE_MISMATCH; passing returns nothing.
 */
export function verifyEvmFeeEcho(extraFee) {
  const fail = () => {
    throw new EvmSwapValidationError('EVM_SWAP_FEE_MISMATCH', 'The quote did not confirm the Fluxio fee settings. Try again in a moment. No funds moved.');
  };
  if (!extraFee || typeof extraFee !== 'object') fail();
  if (String(extraFee.feeAmount) !== String(EVM_SWAP_FEE_OPTIONS.feeAmount)) fail();
  if (Number(extraFee.feeAmount) !== EVM_SWAP_FEE_OPTIONS.feeAmount) fail();
  if (extraFee.isInBps !== true) fail();
  if (extraFee.chargeFeeBy !== 'currency_in') fail();
  if (String(extraFee.feeReceiver).toLowerCase() !== EVM_SWAP_FEE_RECEIVER.toLowerCase()) fail();
}

/**
 * The displayed Fluxio fee in the PAY currency's raw unit (owner
 * keputusan 5): floor(amountIn × 85 / 10000), pure BigInt — 5e14 wei
 * (0,0005 BNB) → 4.250.000.000.000 wei = 0.00000425 BNB (this line used
 * to say 0.0000425 — the same one-zero slip 0221's approval text had,
 * corrected by prompt 0223 against the exponent itself).
 */
export function computeEvmSwapFeeRaw(amountInRaw) {
  return (BigInt(amountInRaw) * BigInt(EVM_SWAP_FEE_OPTIONS.feeAmount)) / 10000n;
}

/**
 * Pure USD-leg deviation for the sanity guard (owner keputusan 0220 butir
 * 5): |inUsd − outUsd| / inUsd as a fraction, computed from raw amounts
 * and the portfolio cache's own per-coin USD prices. Returns null when
 * any input is unusable — the caller then SKIPS the check (never fails
 * on missing data).
 */
export function computeQuoteUsdDeviation({ amountInRaw, inputDecimals, inputUsdPrice, amountOutRaw, outputDecimals, outputUsdPrice }) {
  const inPrice = Number(inputUsdPrice);
  const outPrice = Number(outputUsdPrice);
  if (!Number.isFinite(inPrice) || inPrice <= 0 || !Number.isFinite(outPrice) || outPrice <= 0) return null;
  let inUsd, outUsd;
  try {
    inUsd = (Number(BigInt(amountInRaw)) / 10 ** Number(inputDecimals)) * inPrice;
    outUsd = (Number(BigInt(amountOutRaw)) / 10 ** Number(outputDecimals)) * outPrice;
  } catch {
    return null;
  }
  if (!Number.isFinite(inUsd) || inUsd <= 0 || !Number.isFinite(outUsd)) return null;
  return Math.abs(inUsd - outUsd) / inUsd;
}

// ---- Tahap C (prompt 0223): ERC-20 allowance/approve + native received ----
//
// The token-in direction (USDT to BNB) needs an ERC-20 approve to the
// Kyber router before the router may pull the pay token. These helpers
// live HERE, not in evmTransactionService.js, by owner keputusan K7: the
// swap flow is their only consumer, and evmTransactionService stays
// deliberately decimals/registry-agnostic. Same boundary as everything
// above: nothing here signs or broadcasts on its own initiative.

/** keccak256("allowance(address,address)")[:4] — standard ERC-20 selector. */
const ERC20_ALLOWANCE_SELECTOR = '0xdd62ed3e';
/** keccak256("approve(address,uint256)")[:4] — standard ERC-20 selector. */
const ERC20_APPROVE_SELECTOR = '0x095ea7b3';

function padAddress32(address) {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new EvmSwapValidationError('INVALID_TOKEN', 'A valid 0x address is required.');
  }
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

/**
 * One eth_call allowance(owner, spender) on the pay token (read-only).
 * An empty "0x" result (no contract / dead contract) reads as 0n — the
 * same fail-closed shape tokenService's balanceOf reads use.
 * @returns {Promise<bigint>}
 */
export async function getErc20Allowance({ networkKey, tokenAddress, owner, spender }) {
  requireChainSlug(networkKey);
  const network = NETWORKS[networkKey];
  const data = ERC20_ALLOWANCE_SELECTOR + padAddress32(owner) + padAddress32(spender);
  let result;
  try {
    result = await fetchRpcWithFallback(network, {
      jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: tokenAddress, data }, 'latest']
    });
  } catch (error) {
    throw new EvmSwapValidationError('EVM_SWAP_SEND_FAILED', `Could not read the token allowance: ${error?.message || 'unknown error'}`);
  }
  if (!result?.result || result.result === '0x') return 0n;
  return BigInt(result.result);
}

/**
 * One eth_call balanceOf(owner) on the pay token (read-only) — the
 * server-side half of K3's "USDT >= amountIn" gate. Same "0x" -> 0n rule
 * as the allowance read above.
 * @returns {Promise<bigint>}
 */
export async function getErc20Balance({ networkKey, tokenAddress, owner }) {
  requireChainSlug(networkKey);
  const network = NETWORKS[networkKey];
  const data = '0x70a08231' + padAddress32(owner);
  let result;
  try {
    result = await fetchRpcWithFallback(network, {
      jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: tokenAddress, data }, 'latest']
    });
  } catch (error) {
    throw new EvmSwapValidationError('EVM_SWAP_SEND_FAILED', `Could not read the token balance: ${error?.message || 'unknown error'}`);
  }
  if (!result?.result || result.result === '0x') return 0n;
  return BigInt(result.result);
}

/**
 * Pure calldata for approve(spender, amountRaw) — EXACTLY amountRaw, the
 * owner's K1 decision (never unlimited). amountRaw 0 is VALID since 0227
 * (0225 K8): USDT-class tokens revert a non-zero approve while the live
 * allowance is non-zero ("To change the approve amount you first have to
 * reduce the addresses allowance to zero" — the USDT contract's own rule,
 * chain-checked in the 0225 fase 2 evidence), so the staged flow sends
 * approve(0) first whenever 0 < allowance < amountIn, for EVERY token.
 * @returns {string} 0x-prefixed calldata.
 */
export function buildErc20ApproveCalldata({ spender, amountRaw }) {
  let amount;
  try {
    amount = BigInt(amountRaw);
  } catch {
    throw new EvmSwapValidationError('INVALID_AMOUNT', 'amountRaw must be a raw integer amount.');
  }
  if (amount < 0n) {
    throw new EvmSwapValidationError('INVALID_AMOUNT', 'Amount must be 0 or greater.');
  }
  return ERC20_APPROVE_SELECTOR + padAddress32(spender) + amount.toString(16).padStart(64, '0');
}

/**
 * One eth_getBalance at an EXPLICIT block tag (hex) — K4's two reads
 * around the receipt block. fetchRpcWithFallback itself moves to the next
 * endpoint when one refuses a historic block (the 0213 publicnode
 * pattern).
 * @returns {Promise<bigint>}
 */
export async function getEvmBalanceAtBlock({ networkKey, address, blockHex }) {
  requireChainSlug(networkKey);
  const network = NETWORKS[networkKey];
  const result = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, blockHex]
  });
  if (!result?.result) throw new EvmSwapValidationError('EVM_SWAP_SEND_FAILED', 'Balance read returned no result.');
  return BigInt(result.result);
}

/**
 * Pure K4 formula (owner keputusan): the native BNB a swap credited =
 * balance(receipt block) − balance(receipt block − 1) + gasUsed ×
 * effectiveGasPrice (the gas the tx itself paid, added back). Returns the
 * raw wei as a decimal string, or null when any input is malformed or
 * the result is negative (then the estimate keeps showing, labeled est.
 * — the BOUNDS checks against the quote live at the caller, which knows
 * the quote).
 *
 * Same-block approve (0223 Revisi 1, owner keputusan): when the approve
 * and the swap land in the SAME block, the balance delta already carries
 * the approve's own gas too — the caller passes it as extraGasUsed /
 * extraEffectiveGasPrice and it is added back, so the figure stays exact
 * instead of undercounting into the est. fallback. A provided-but-
 * malformed extra pair returns null (fail safe, never fail wrong).
 *
 * L1 data fee (0227, from the 0226 real receipt): an op-stack network
 * (Base) charges l1Fee OUTSIDE gasUsed × effectiveGasPrice — the 0226
 * send's balance sheet only closed once l1Fee (2.195.885.060 wei on the
 * real receipt) was included. The caller passes the receipt's own l1Fee
 * when the field is present (presence-driven, never assumed per network)
 * and it is added back exactly like the gas. Malformed → null.
 */
export function computeEvmNativeReceivedFromBalances({ balanceBeforeWei, balanceAfterWei, gasUsed, effectiveGasPrice, extraGasUsed = null, extraEffectiveGasPrice = null, l1FeeWei = null }) {
  let received;
  try {
    received = BigInt(balanceAfterWei) - BigInt(balanceBeforeWei) + BigInt(gasUsed) * BigInt(effectiveGasPrice);
    if (extraGasUsed != null || extraEffectiveGasPrice != null) {
      received += BigInt(extraGasUsed) * BigInt(extraEffectiveGasPrice);
    }
    if (l1FeeWei != null) {
      received += BigInt(l1FeeWei);
    }
  } catch {
    return null;
  }
  if (received < 0n) return null;
  return received.toString();
}
