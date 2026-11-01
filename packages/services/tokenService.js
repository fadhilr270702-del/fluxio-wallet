/**
 * Token (SPL / ERC-20) balance lookups. Read-only — same contract as
 * balanceService.js: never touches key material, never signs anything,
 * built on the same @fluxio/crypto/rpc's fetchRpcWithFallback() rather
 * than duplicating request/response/fallback/timeout handling here.
 *
 * The two chain families work fundamentally differently, so they don't
 * share a code path beyond the RPC plumbing:
 *   - Solana has genuine auto-discovery: getTokenAccountsByOwner returns
 *     every SPL token account the owner holds, no registry needed to find
 *     them. The registry (+ any custom tokens) is only consulted to turn
 *     a mint address into a symbol/name for display; an unrecognized mint
 *     still shows up, labeled "Unknown".
 *   - EVM has no discovery without a third-party indexer, which this repo
 *     doesn't have — so the registry+custom list *is* what gets checked:
 *     one eth_call per token, and only tokens actually in that list can
 *     ever appear.
 *
 * All amount math is BigInt end to end — same reasoning as
 * balanceService.js/formatUnits.js: a raw token amount routed through a
 * JS Number risks silent precision loss well within realistic balances.
 */
import { fetchRpcWithFallback, RpcUnreachableError } from '@fluxio/crypto/rpc';
import { getAccountForNetwork } from '@fluxio/crypto/wallet';
import { NETWORKS, ACCOUNT_TYPES, mergeTokens } from '@fluxio/constants';
import { formatUnits } from '@fluxio/utils/formatUnits';
import { decodeAbiString, decodeAbiUint } from '@fluxio/utils/abiDecode';

const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** keccak256("balanceOf(address)")[:4] — standard ERC-20 selector, same value everywhere, not network-specific. */
const ERC20_BALANCE_OF_SELECTOR = '0x70a08231';
/** Standard ERC-20 metadata selectors — used only by fetchErc20Metadata() below, the "Add custom token" auto-fetch, never by the balance path above. Verified against ethers' own `id("symbol()")` etc. while building this. */
const ERC20_SYMBOL_SELECTOR = '0x95d89b41';
const ERC20_NAME_SELECTOR = '0x06fdde03';
const ERC20_DECIMALS_SELECTOR = '0x313ce567';

/**
 * Fetches every held token balance for one network, given the current
 * public wallet model (as returned by walletService.getPublicWallet())
 * and an optional list of locally-registered custom tokens for this
 * network (already scoped to `networkKey` by the caller — see
 * @fluxio/constants/tokens.js's mergeTokens() for the merge shape).
 *
 * @param {string} networkKey - a @fluxio/constants network key.
 * @param {object} wallet - the public wallet model (never contains secrets).
 * @param {{ customTokens?: Array<{symbol,name,decimals,address}> }} [opts]
 * @returns {Promise<Array<{ symbol, name, amountRaw: string, decimals, amountFormatted: string, address }>>}
 */
export async function getTokenBalances(networkKey, wallet, { customTokens = [] } = {}) {
  const network = NETWORKS[networkKey];
  if (!network) {
    throw new Error(`Unknown network: ${networkKey}`);
  }
  const { address } = getAccountForNetwork(wallet, networkKey);

  return network.accountType === ACCOUNT_TYPES.SOLANA
    ? fetchSolanaTokenBalances(network, networkKey, address, customTokens)
    : fetchEvmTokenBalances(network, networkKey, address, customTokens);
}

/**
 * KNOWN ISSUE (prompt 0116) — CONDITIONALLY RESOLVED as of prompt 0130,
 * not fully closed for every build. Original finding, still accurate as
 * history: the mainnet `solana` network's PUBLIC RPC
 * (`solana-rpc.publicnode.com`, still `networks.js`'s own fallback today)
 * genuinely rejects getTokenAccountsByOwner with a 403 + JSON-RPC error
 * `-32602 "Request blocked"` — reproduced directly, not assumed, and
 * confirmed to be a METHOD-level block, not an origin-specific one: it
 * fails identically with and without a chrome-extension:// Origin header
 * (unlike api.mainnet-beta.solana.com's own failure mode — see below).
 * `getBalance` against the exact same endpoint, same session, succeeds
 * (200) — this is `getTokenAccountsByOwner` specifically, a
 * getProgramAccounts-family method several free-tier providers throttle
 * or disable outright even where simple methods work fine, exactly as
 * this comment originally predicted.
 *
 * `scripts/verify-rpc-endpoints.mjs`'s `runGtaboEvaluation()` (prompt
 * 0116) runs this same dual-mode check (plain + synthetic
 * chrome-extension:// Origin header) against 16 candidate free/public
 * mainnet Solana RPC endpoints. Originally 0 of 16 passed; re-run while
 * verifying prompt 0130's own work found free/public endpoint
 * availability had drifted since (as this comment's own prior version
 * warned it would) — `solana.leorpc.com/?api_key=FREE` now passes both
 * modes (1 of 16). That candidate is deliberately NOT wired into
 * `networks.js` as a replacement default: a shared, non-personal
 * `api_key=FREE` query-string key baked into a public URL is exactly the
 * class of fragile, could-vanish-anytime endpoint this whole prompt is
 * moving away from, not a foundation to build a "fixed" default on. Re-run
 * `node scripts/verify-rpc-endpoints.mjs` for the current count — this
 * number will keep drifting either direction over time.
 *
 * The actual fix (prompt 0130) is `apps/extension/background/
 * background.js`'s own build-time Helius injection, NOT a change to this
 * file or to `networks.js`'s own committed defaults — see that file's own
 * header comment for the full mechanism. When a contributor/build has a
 * Helius API key configured (`apps/extension/.env.local`, see
 * `.env.example`), the mainnet `solana` network's RPC default becomes
 * Helius's own endpoint for that build, and `runHeliusEvaluation()`
 * (`scripts/verify-rpc-endpoints.mjs`, prompt 0130) confirms
 * getTokenAccountsByOwner passes Helius in BOTH the plain AND synthetic
 * chrome-extension:// Origin modes — the exact two failure modes this
 * comment has always tracked, verified against Helius specifically, not
 * assumed from its marketing copy. **Without a configured key (the
 * default for any build that hasn't set one up — this is optional, never
 * required to build), the network falls back to the exact same public
 * endpoint documented above, and this KNOWN ISSUE still applies
 * unchanged**: mainnet SPL balances still fail on an un-keyed build,
 * while solana-devnet/solana-local remain unaffected either way (this was
 * always method+network-specific, not a general RPC-plumbing bug in the
 * code below). Re-run `node scripts/verify-rpc-endpoints.mjs` for the
 * current state of both evaluations — endpoint/provider availability
 * drifts over time, and this comment will go stale exactly the way the
 * previous version of it did if not re-verified.
 */
async function fetchSolanaTokenBalances(network, networkKey, ownerAddress, customTokens) {
  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'getTokenAccountsByOwner',
    // Without an explicit commitment, Solana RPC defaults to 'finalized' —
    // confirmed directly (see this slice's local-integration test, and
    // the identical default-commitment gap already documented on
    // transactionService.js's own commitment handling) to lag several
    // slots behind a transaction that's already 'confirmed'. Requesting
    // 'confirmed' explicitly matches what @solana/spl-token's own
    // sendAndConfirmTransaction default waits for, so a token minted/sent
    // moments ago reliably shows up instead of racing finalization.
    params: [ownerAddress, { programId: SPL_TOKEN_PROGRAM_ID }, { encoding: 'jsonParsed', commitment: 'confirmed' }]
  });

  // Registry+custom is only used for the mint -> symbol/name lookup below,
  // never to decide which mints get checked — see the file header comment.
  const knownByMint = new Map(mergeTokens(networkKey, customTokens).map((token) => [token.address, token]));

  const accounts = data.result?.value ?? [];
  const balances = [];
  for (const entry of accounts) {
    // One malformed/unexpected account entry must never take the rest of
    // the owner's token accounts down with it — same "per-item failure
    // isolation" principle as fetchEvmTokenBalances()'s per-token
    // try/catch (see that function's own comment for the live EVM bug
    // that motivated it); nothing has reproduced a Solana-side equivalent
    // yet, but BigInt(tokenAmount.amount) below throws on anything
    // non-numeric, and there's no guarantee every token program variant
    // an owner happens to hold an account for shapes `tokenAmount.amount`
    // the same way — so this loop iteration is isolated the same way.
    try {
      const info = entry?.account?.data?.parsed?.info;
      const tokenAmount = info?.tokenAmount;
      if (!info || !tokenAmount) continue; // defensive — an unparseable/unexpected account shape is skipped, not fatal to the rest

      const amountRaw = BigInt(tokenAmount.amount);
      if (amountRaw === 0n) continue; // e.g. a closed-but-not-yet-garbage-collected account

      // decimals always comes from the RPC response itself (authoritative,
      // per-mint), never from the registry — see the file header comment.
      const decimals = tokenAmount.decimals;
      const known = knownByMint.get(info.mint);
      balances.push({
        symbol: known?.symbol ?? 'Unknown',
        name: known?.name ?? shortenMint(info.mint),
        amountRaw: amountRaw.toString(),
        decimals,
        amountFormatted: formatUnits(amountRaw, decimals),
        address: info.mint
      });
    } catch {
      continue;
    }
  }
  return balances;
}

/** "HM2t…6TFy"-style label for a mint this file has no registry/custom entry for — display-only, never used to re-identify the token. */
function shortenMint(mint) {
  return mint.length <= 10 ? mint : `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

async function fetchEvmTokenBalances(network, networkKey, ownerAddress, customTokens) {
  const tokens = mergeTokens(networkKey, customTokens);
  if (!tokens.length) return []; // no registry call needed — matches solana-local/ethereum-local's "empty until a custom token is registered" default

  const results = await Promise.all(
    tokens.map(async (token) => {
      // A single stale/broken registry or custom-token entry must never
      // take the whole network's token list down with it — confirmed
      // live: a custom-token entry pointing at a contract that no longer
      // exists (routine after a local anvil restart — every previously
      // deployed address vanishes, but a chrome.storage.local custom-
      // token entry for it survives the restart untouched) made the
      // *entire* fetch fail, not just that one token, because
      // fetchErc20Balance's BigInt() throw for that one token propagated
      // out of Promise.all and rejected the whole thing. Anything else
      // this can't anticipate (a malformed response, an unexpected RPC
      // quirk from one specific contract) gets the same isolation.
      try {
        const amountRaw = await fetchErc20Balance(network, token.address, ownerAddress);
        if (amountRaw === 0n) return null; // "Saldo 0 tidak usah dikembalikan" — also where a dead-contract's 0x result lands, see fetchErc20Balance
        return {
          symbol: token.symbol,
          name: token.name,
          amountRaw: amountRaw.toString(),
          decimals: token.decimals,
          amountFormatted: formatUnits(amountRaw, token.decimals),
          address: token.address
        };
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

async function fetchErc20Balance(network, tokenAddress, ownerAddress) {
  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: tokenAddress, data: `${ERC20_BALANCE_OF_SELECTOR}${padAddressForCalldata(ownerAddress)}` }, 'latest']
  });
  // An address with no contract deployed at it (or a selector a contract
  // doesn't implement) doesn't revert — eth_call just returns empty
  // return data, "0x", not a JSON-RPC error. There is genuinely no
  // balance to report there, so this is treated as exactly that (0n),
  // not an error: BigInt("0x") itself throws (confirmed directly —
  // "Cannot convert 0x to a BigInt"), which is what turned a routine
  // dead-contract custom-token entry into a fetchEvmTokenBalances()-wide
  // failure before this fix (see that function's own comment).
  if (!data.result || data.result === '0x') {
    return 0n;
  }
  // Same reasoning as balanceService.js's fetchEvmWei: eth_call returns a
  // "0x..." hex string specifically so a large balance isn't mangled by
  // JSON-number precision — BigInt() parses it directly, no manual parsing.
  return BigInt(data.result);
}

/** ABI-encodes a 20-byte address as balanceOf(address)'s single 32-byte argument (left-padded with zeros), without the leading "0x" already present on the selector. */
function padAddressForCalldata(address) {
  return address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

// ---- "Add custom token" support (apps/extension's Manage Tokens UI) ----
//
// Everything below is still read-only (no signing, no key material — same
// contract as the balance path above), but serves a different caller:
// background.js's FLUXIO_INTERNAL_ADD_CUSTOM_TOKEN handler, fetching a
// token's on-chain metadata (symbol/name/decimals) at the moment a user
// registers it, rather than trusting hand-typed values for anything the
// chain itself can answer authoritatively.

/**
 * Fetches an ERC-20 contract's symbol()/name()/decimals() in parallel —
 * three CONCURRENT eth_calls against the same endpoint. Each field
 * independently resolves to its decoded value or `null` (that one
 * field's call returned empty data, or didn't decode) — a contract
 * missing one optional field doesn't invalidate the other two, matching
 * how real (if non-strictly-compliant) tokens sometimes omit one of
 * these.
 *
 * Throws in exactly two cases the caller needs to tell apart:
 *   - a genuine RPC-level failure — rethrown AS-IS (a real
 *     RpcUnreachableError instance, see @fluxio/crypto/rpc's own
 *     comment), so a caller can check `instanceof RpcUnreachableError`
 *     rather than pattern-matching a message string. This is decided by
 *     ERROR TYPE, not by requiring all three calls to fail identically —
 *     see the REVISION 1 note below for why that distinction matters.
 *   - every field genuinely came back empty ("0x") with NO transport
 *     failure anywhere among the three — a real "there is no contract
 *     deployed at this address" (the same "empty result means no
 *     contract" fact getTokenBalances()'s own fetchErc20Balance() relies
 *     on, applied here at registration time instead of balance-check
 *     time, so a dead address is refused up front rather than silently
 *     added and skipped forever after).
 *
 * REVISION 1 (prompt 0119's own bug fix, see
 * prompt/0119-add-token-ux-two-step.md): the ORIGINAL version of this
 * function only reclassified "every field is empty" as an RPC failure
 * when ALL THREE calls rejected identically
 * (`results.every(status==='rejected')`). Real manual verification found
 * this too strict: with a genuinely dead local anvil, ONE of the three
 * concurrent requests could still come back with a real (if empty) HTTP
 * response while the OTHER TWO failed to even connect — and that single
 * "successful but empty" result silently outvoted two real connection
 * failures, misreporting "No contract found" for an RPC that was
 * actually just unreachable (reproduced directly in this file's own
 * tests with a mocked fetch shaped exactly that way, proven to fail
 * before this fix and pass after).
 *
 * THE FIX: if there's no real (non-empty) data from ANY of the three
 * fields, check whether even ONE of the settled results is a REJECTED
 * promise whose reason is an RpcUnreachableError (a real transport/
 * protocol-level failure — see that class's own comment). If so, the
 * honest conclusion is "the RPC is unreliable right now," not "there is
 * definitely no contract here" — a single flaky/unreachable attempt
 * among three concurrent identical requests to the SAME endpoint is
 * strong evidence the node itself is the problem. This check is
 * deliberately TYPE-based (`instanceof RpcUnreachableError`), not a
 * message-string whitelist/pattern — the exact kind of fragile
 * classification the original bug report asked to move away from.
 * Conversely, if AT LEAST ONE field resolved with REAL, non-empty data,
 * that's independent proof the node is alive and genuinely answering —
 * a co-occurring transport hiccup on a different field is then treated
 * the same as before (that one field is simply null), since there's no
 * ambiguity left to resolve.
 *
 * @param {string} networkKey
 * @param {string} address
 * @returns {Promise<{ symbol: string|null, name: string|null, decimals: number|null }>}
 */
export async function fetchErc20Metadata(networkKey, address) {
  const network = requireEvmNetwork(networkKey);

  const results = await Promise.allSettled([
    fetchErc20MetadataField(network, address, ERC20_SYMBOL_SELECTOR),
    fetchErc20MetadataField(network, address, ERC20_NAME_SELECTOR),
    fetchErc20MetadataField(network, address, ERC20_DECIMALS_SELECTOR)
  ]);
  const [symbolResult, nameResult, decimalsResult] = results;

  const symbolHex = symbolResult.status === 'fulfilled' ? symbolResult.value : null;
  const nameHex = nameResult.status === 'fulfilled' ? nameResult.value : null;
  const decimalsHex = decimalsResult.status === 'fulfilled' ? decimalsResult.value : null;

  const symbol = symbolHex ? decodeAbiString(symbolHex) : null;
  const name = nameHex ? decodeAbiString(nameHex) : null;
  const decimalsRaw = decimalsHex ? decodeAbiUint(decimalsHex) : null;
  const decimals = decimalsRaw !== null ? Number(decimalsRaw) : null;

  const hasAnyRealData = symbol != null || name != null || decimals !== null;

  if (!hasAnyRealData) {
    // Nothing came back from ANY of the three fields — see this
    // function's own REVISION 1 note above for why the next check
    // (rather than requiring every attempt to fail identically) is what
    // correctly protects against a flaky/partially-reachable RPC.
    const transportFailure = results.find((r) => r.status === 'rejected' && r.reason instanceof RpcUnreachableError);
    if (transportFailure) {
      throw transportFailure.reason;
    }
    if (results.every((r) => r.status === 'rejected')) {
      // Every attempt failed, but not (only) via a genuine transport
      // error — an unanticipated failure shape. Surface the first
      // reason rather than silently treating this as "no contract".
      throw results[0].reason;
    }
    throw new Error(`No contract found at ${address} on ${network.name}.`);
  }

  return { symbol, name, decimals };
}

/** One symbol()/name()/decimals() eth_call — returns the raw hex result, or null for empty return data ("0x", i.e. this specific selector isn't implemented/returned nothing). Still throws on a genuine RPC failure — the caller (fetchErc20Metadata) is what decides how to interpret a throw vs. a null. */
async function fetchErc20MetadataField(network, address, selector) {
  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: address, data: selector }, 'latest']
  });
  if (!data.result || data.result === '0x') return null;
  return data.result;
}

/**
 * Fetches a Solana mint account's decimals — the one metadata field this
 * repo needs for a custom SPL token that's always authoritative on-chain
 * (see @fluxio/constants/tokens.js's own note on this: getTokenBalances()
 * never trusts a registry/custom-entry decimals value for Solana, only
 * ever what the RPC itself reports). Deliberately does NOT attempt to
 * read a symbol/name from on-chain metadata (the Metaplex Token Metadata
 * program) — see this repo's "Add custom token" feature notes for why
 * that's an explicit scope cut, not an oversight.
 *
 * Throws if the address doesn't exist, or exists but isn't actually an
 * SPL mint account (getAccountInfo's jsonParsed `type` isn't `'mint'`) —
 * both cases the caller should treat as "not a valid token to register."
 *
 * @param {string} networkKey
 * @param {string} address
 * @returns {Promise<{ decimals: number }>}
 */
export async function fetchSolanaMintInfo(networkKey, address) {
  const network = requireSolanaNetwork(networkKey);

  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'getAccountInfo',
    params: [address, { encoding: 'jsonParsed', commitment: 'confirmed' }]
  });

  const value = data.result?.value;
  const parsed = value?.data?.parsed;
  if (!value || parsed?.type !== 'mint') {
    throw new Error(`No SPL mint found at ${address} on ${network.name}.`);
  }
  const decimals = parsed.info?.decimals;
  if (typeof decimals !== 'number') {
    throw new Error(`Could not read decimals for the mint at ${address} on ${network.name}.`);
  }
  return { decimals };
}

function requireEvmNetwork(networkKey) {
  const network = NETWORKS[networkKey];
  if (!network) throw new Error(`Unknown network: ${networkKey}`);
  if (network.accountType !== ACCOUNT_TYPES.EVM) throw new Error(`${network.name} is not an EVM network.`);
  return network;
}

function requireSolanaNetwork(networkKey) {
  const network = NETWORKS[networkKey];
  if (!network) throw new Error(`Unknown network: ${networkKey}`);
  if (network.accountType !== ACCOUNT_TYPES.SOLANA) throw new Error(`${network.name} is not a Solana network.`);
  return network;
}
