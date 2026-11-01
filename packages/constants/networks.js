import { ACCOUNT_TYPES } from './derivationPaths.js';

/**
 * Centralized network/chain configuration.
 *
 * No secrets live here — only public default RPC endpoints, PLUS one
 * narrow, build-time-injected exception documented immediately below
 * (prompt 0130 Revision 1) for Solana mainnet specifically. Apps that need
 * a DIFFERENT authenticated/private RPC provider at runtime (a second key
 * for a different app/environment) should inject an override via
 * `withRpcOverrides()` further down, sourced from their own env/config
 * layer (e.g. Vite's `import.meta.env`), never by editing this file with a
 * hardcoded key.
 *
 * HELIUS_API_KEY injection (prompt 0130, moved here in Revision 1 — see
 * that revision's own report for the full root-cause story). Originally
 * this key was injected as a `withRpcOverrides()` call inside
 * apps/extension/background.js, shadowing that file's own local `NETWORKS`
 * import — which turned out to be completely inert: every
 * @fluxio/services function (tokenService.js's getTokenBalances,
 * balanceService.js's getNativeBalance, historyService.js's
 * getSolanaChainHistory, ...) does its OWN internal `NETWORKS[networkKey]`
 * lookup against THIS file's own module-level export, never against
 * background.js's locally-shadowed copy — so every real RPC call kept
 * hitting the old public endpoint regardless of what background.js
 * thought it had overridden. Proven with a real Chrome network-tab
 * capture, not just inferred: zero requests to mainnet.helius-rpc.com,
 * every mainnet Solana request still hitting solana-rpc.publicnode.com
 * and 403ing exactly as prompt 0116 documented.
 *
 * The fix: inject at the ONE place every consumer actually reads from —
 * this file's own construction of the frozen `NETWORKS` object, at
 * module-evaluation time, so there is no override STEP to reach or miss;
 * the object is simply already correct the moment it exists. `__FLUXIO_
 * HELIUS_API_KEY__` is not a real global — apps/extension/build.mjs's
 * esbuild `define` replaces every occurrence of this exact identifier
 * with a literal string at BUILD time (the key from
 * apps/extension/.env.local, or `""` when absent) before background.js
 * (which transitively bundles this whole file as source, not as a
 * separate runtime package) is ever bundled. Guarded with `typeof`, never
 * a bare reference: this file is ALSO imported directly by apps/web
 * (Vite), every Vitest suite, and every scripts/*.mjs Node script — none
 * of which ever run through that specific esbuild `define`, and a bare
 * reference to an identifier no bundler ever substituted would throw
 * ReferenceError there. `typeof x` on an identifier that was never
 * declared as a variable anywhere safely evaluates to the string
 * `'undefined'` instead of throwing — a JS-spec guarantee, not a
 * workaround — so this stays a no-op everywhere except the one esbuild
 * bundle that actually defines it.
 */
/* eslint-disable no-undef -- __FLUXIO_HELIUS_API_KEY__ is a build-time-only
   identifier substituted by esbuild's `define` in exactly one consumer
   (apps/extension/build.mjs); see the comment above for why a `typeof`
   guard makes this safe in every other context that imports this file. */
const INJECTED_HELIUS_API_KEY =
  typeof __FLUXIO_HELIUS_API_KEY__ !== 'undefined' && __FLUXIO_HELIUS_API_KEY__ ? __FLUXIO_HELIUS_API_KEY__ : '';
/* eslint-enable no-undef */

export const NETWORK_KEYS = Object.freeze({
  SOLANA: 'solana',
  SOLANA_DEVNET: 'solana-devnet',
  SOLANA_LOCAL: 'solana-local',
  ETHEREUM: 'ethereum',
  ETHEREUM_SEPOLIA: 'ethereum-sepolia',
  ETHEREUM_LOCAL: 'ethereum-local',
  BNB: 'bnb',
  BASE: 'base'
});

export const NETWORKS = Object.freeze({
  // api.mainnet-beta.solana.com is deliberately NOT used as the PUBLIC
  // fallback here: verified (scripts/verify-rpc-endpoints.mjs + a manual
  // Origin-header check) that it returns 403 "Access forbidden"
  // specifically when the request carries a chrome-extension:// Origin
  // header — it works fine for a plain Node caller with no Origin header,
  // but that makes it silently broken for the one live consumer of this
  // config that matters most (apps/extension/background.js).
  // solana-rpc.publicnode.com passed the same extension-origin check
  // cleanly (ACAO: *). No free/keyless Solana mainnet RPC could be found
  // that also passes getTokenAccountsByOwner specifically, though (see
  // tokenService.js's own KNOWN ISSUE comment, prompt 0116) — this is
  // exactly why `default` below becomes Helius, conditionally, rather
  // than staying on this endpoint unconditionally.
  //
  // rpc.default is conditionally Helius (prompt 0130, moved to this exact
  // spot in Revision 1 — see this file's own header comment above for the
  // full injection mechanism/root-cause story): when
  // INJECTED_HELIUS_API_KEY is a real key (build-time-injected via
  // apps/extension/build.mjs, empty everywhere else — apps/web, every
  // Vitest suite, every scripts/*.mjs script), `default` becomes Helius's
  // own mainnet endpoint, and solana-rpc.publicnode.com — this network's
  // OWN previous default — is demoted into `fallbacks` rather than
  // discarded, so a Helius outage/rate-limit still degrades to the
  // exact same verified-working public endpoint this network used before
  // prompt 0130. With no key (the default for any build that hasn't
  // configured one, including apps/web and every test/script import of
  // this file), `default` stays exactly what it always was, with no
  // fallback — unchanged behavior, not a regression for anyone without a
  // key.
  [NETWORK_KEYS.SOLANA]: Object.freeze({
    key: NETWORK_KEYS.SOLANA,
    name: 'Solana',
    accountType: ACCOUNT_TYPES.SOLANA,
    cluster: 'mainnet-beta',
    isTestnet: false,
    nativeCurrency: Object.freeze({ name: 'Solana', symbol: 'SOL', decimals: 9 }),
    rpc: Object.freeze(
      INJECTED_HELIUS_API_KEY
        ? {
            default: `https://mainnet.helius-rpc.com/?api-key=${INJECTED_HELIUS_API_KEY}`,
            fallbacks: Object.freeze(['https://solana-rpc.publicnode.com'])
          }
        : {
            default: 'https://solana-rpc.publicnode.com',
            fallbacks: Object.freeze([])
          }
    ),
    explorer: Object.freeze({ name: 'Solana Explorer', url: 'https://explorer.solana.com' })
  }),
  // Devnet: free, faucet-airdrop-able, no API key — api.devnet.solana.com
  // specifically (not swapped like mainnet above) because requestAirdrop
  // needs the real Solana Labs devnet cluster; verified it passes the same
  // extension-origin check mainnet failed. No fallback: the one candidate
  // that looked plausible (solana-devnet-rpc.publicnode.com) doesn't
  // exist (404) — verified, not assumed. The previous fallback here,
  // rpc.ankr.com/solana_devnet, now hard-requires an API key (confirmed
  // via both this file's own verification script and the real failure
  // this fix responds to) and has been removed outright, not replaced
  // with another unverified guess.
  [NETWORK_KEYS.SOLANA_DEVNET]: Object.freeze({
    key: NETWORK_KEYS.SOLANA_DEVNET,
    name: 'Solana Devnet',
    accountType: ACCOUNT_TYPES.SOLANA,
    cluster: 'devnet',
    isTestnet: true,
    nativeCurrency: Object.freeze({ name: 'Solana', symbol: 'SOL', decimals: 9 }),
    rpc: Object.freeze({
      default: 'https://api.devnet.solana.com',
      fallbacks: Object.freeze([])
    }),
    explorer: Object.freeze({ name: 'Solana Explorer', url: 'https://explorer.solana.com' })
  }),
  // A local solana-test-validator (run manually by a developer, typically
  // via WSL — see CLAUDE.md and scripts/devnet-transfer-demo.mjs's
  // FLUXIO_DEMO_NETWORK=local mode) — added because the public devnet
  // faucet has been unreliable for extended periods, and this needs no
  // faucet at all: `solana airdrop` against a local validator is
  // unrestricted. Only reachable while that validator is actually running
  // on 127.0.0.1:8899 — there's no hosted fallback for a local process, so
  // `fallbacks` is empty, same as mainnet above. isTestnet: true so it
  // passes every existing testnet-only guard (the extension's Send UI,
  // requestDevnetAirdrop's mainnet guard, background.js's SEND_TRANSFER
  // guard, ...) the same way solana-devnet already does, with no
  // network-specific special-casing needed in any of them.
  [NETWORK_KEYS.SOLANA_LOCAL]: Object.freeze({
    key: NETWORK_KEYS.SOLANA_LOCAL,
    name: 'Solana Local',
    accountType: ACCOUNT_TYPES.SOLANA,
    cluster: 'localnet',
    isTestnet: true,
    nativeCurrency: Object.freeze({ name: 'Solana', symbol: 'SOL', decimals: 9 }),
    rpc: Object.freeze({
      default: 'http://127.0.0.1:8899',
      fallbacks: Object.freeze([])
    }),
    explorer: Object.freeze({
      name: 'Solana Explorer',
      url: 'https://explorer.solana.com',
      // explorer.solana.com has no built-in notion of a local validator —
      // its documented way to point at an arbitrary RPC endpoint is the
      // `cluster=custom&customUrl=...` query pair, not the plain
      // `?cluster=<name>` suffix every other non-mainnet network here uses
      // (see transactionService.js's solanaExplorerUrl(), which checks for
      // this field before falling back to the `cluster`-based suffix).
      clusterQueryOverride: `cluster=custom&customUrl=${encodeURIComponent('http://127.0.0.1:8899')}`
    })
  }),
  // ethereum-rpc.publicnode.com was already the default and still passes
  // the extension-origin check — untouched. eth.llamarpc.com (the old
  // fallback) now returns HTTP 521 (origin down) — verified dead, swapped
  // for eth.drpc.org, which passed the same check cleanly.
  [NETWORK_KEYS.ETHEREUM]: Object.freeze({
    key: NETWORK_KEYS.ETHEREUM,
    name: 'Ethereum',
    accountType: ACCOUNT_TYPES.EVM,
    chainId: 1,
    isTestnet: false,
    // Tip floor (prompt 0231, owner approved): the public fee endpoints can
    // answer eth_maxPriorityFeePerGas with ~0 (measured 3.839 wei while the
    // real inclusion median was ~0.096 gwei), and a 0 tip tx can hang in a
    // busy mempool. 0.1 gwei ~= the measured feeHistory p50.
    tipFloorWei: 100000000n,
    nativeCurrency: Object.freeze({ name: 'Ether', symbol: 'ETH', decimals: 18 }),
    rpc: Object.freeze({
      default: 'https://ethereum-rpc.publicnode.com',
      fallbacks: Object.freeze(['https://eth.drpc.org'])
    }),
    explorer: Object.freeze({ name: 'Etherscan', url: 'https://etherscan.io' })
  }),
  // Sepolia: current standard Ethereum testnet, free public RPC, no API
  // key. Default unchanged (already verified passing). Fallback swapped:
  // rpc.sepolia.org now 404s (dead domain), sepolia.drpc.org — one of the
  // two candidates offered — rejects Sepolia specifically ("chain is not
  // available on free plan"), and 1rpc.io/sepolia (the other candidate)
  // passed once but then hit its own free-tier rate limit on a second
  // verification pass minutes later (429, "apply an OnFinality API key
  // for a higher rate limit") — too fragile to trust as a fallback that
  // needs to actually be there when the primary is down. Landed on
  // sepolia.gateway.tenderly.co instead (Tenderly's public gateway),
  // which passed the extension-origin check with no rate-limit signal.
  [NETWORK_KEYS.ETHEREUM_SEPOLIA]: Object.freeze({
    key: NETWORK_KEYS.ETHEREUM_SEPOLIA,
    name: 'Ethereum Sepolia',
    accountType: ACCOUNT_TYPES.EVM,
    chainId: 11155111,
    isTestnet: true,
    // Testnet: inclusion is easy; a tiny nonzero floor mirrors Base (0231).
    tipFloorWei: 1000000n,
    nativeCurrency: Object.freeze({ name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 }),
    rpc: Object.freeze({
      default: 'https://ethereum-sepolia-rpc.publicnode.com',
      fallbacks: Object.freeze(['https://sepolia.gateway.tenderly.co'])
    }),
    explorer: Object.freeze({ name: 'Etherscan', url: 'https://sepolia.etherscan.io' })
  }),
  // Anvil (Foundry's local EVM dev node — run manually by a developer,
  // typically via WSL, see CLAUDE.md/scripts/evm-transfer-demo.mjs) plays
  // the same role for the EVM side that solana-local plays for Solana: no
  // faucet/rate-limit to fight against. There's no programmatic-airdrop
  // RPC method for EVM the way Solana has requestAirdrop — anvil's own
  // `anvil_setBalance` (see scripts/evm-transfer-demo.mjs) is the actual
  // equivalent. chainId 31337 is anvil's fixed default (Hardhat's default
  // network happens to reuse the same id, but this entry is specifically
  // anvil's). No fallback: same reasoning as solana-local — there's no
  // hosted equivalent of a developer's own local process.
  //
  // `explorer` is deliberately `null`, not a real explorer's URL: anvil is
  // a private local process, nothing indexes it, so a real explorer
  // domain would only ever produce a dead "transaction not found" link.
  // Every caller that renders an explorer link (evmTransactionService.js's
  // evmExplorerUrl(), the extension's Send-result screen) must treat a
  // null `explorer` as "no explorer available" and hide the link/button
  // entirely, not render a broken one. isTestnet: true for the same
  // reason as solana-local — it must pass every existing testnet-only
  // guard (background.js's SEND_TRANSFER guard chief among them) with no
  // network-specific special-casing needed anywhere.
  [NETWORK_KEYS.ETHEREUM_LOCAL]: Object.freeze({
    key: NETWORK_KEYS.ETHEREUM_LOCAL,
    name: 'Ethereum Local',
    accountType: ACCOUNT_TYPES.EVM,
    chainId: 31337,
    isTestnet: true,
    // Local anvil mines instantly; an explicit 0 disables the floor (0231).
    tipFloorWei: 0n,
    nativeCurrency: Object.freeze({ name: 'Ether', symbol: 'ETH', decimals: 18 }),
    rpc: Object.freeze({
      default: 'http://127.0.0.1:8545',
      fallbacks: Object.freeze([])
    }),
    explorer: null
  }),
  // bsc-dataseed.binance.org (the old default, predates this session) was
  // found to be DNS-hijacked on at least this network — it resolves to an
  // ISP block/landing page instead of Binance's real infrastructure, not
  // just slow or rate-limited — so it can't be trusted as a default
  // regardless of whether it's technically fine elsewhere. Swapped to
  // bsc-rpc.publicnode.com (verified passing) as default, with
  // bsc-dataseed1.defibit.io (a different official BNB Chain dataseed
  // node, also verified passing) as fallback.
  [NETWORK_KEYS.BNB]: Object.freeze({
    key: NETWORK_KEYS.BNB,
    name: 'BNB Chain',
    accountType: ACCOUNT_TYPES.EVM,
    chainId: 56,
    isTestnet: false,
    // Tip floor (0231): the network standard 0.05 gwei (docs.bnbchain.org,
    // 0213 proven; baseFee is always 0 so the tip IS the whole fee).
    tipFloorWei: 50000000n,
    nativeCurrency: Object.freeze({ name: 'BNB', symbol: 'BNB', decimals: 18 }),
    rpc: Object.freeze({
      default: 'https://bsc-rpc.publicnode.com',
      fallbacks: Object.freeze(['https://bsc-dataseed1.defibit.io'])
    }),
    explorer: Object.freeze({ name: 'BscScan', url: 'https://bscscan.com' })
  }),
  // Both endpoints verified passing the extension-origin check — unchanged.
  [NETWORK_KEYS.BASE]: Object.freeze({
    key: NETWORK_KEYS.BASE,
    name: 'Base',
    accountType: ACCOUNT_TYPES.EVM,
    chainId: 8453,
    isTestnet: false,
    // Tip floor (0231): the measured p50 = the tip every real Base tx
    // (0226 through 0229) actually signed.
    tipFloorWei: 1000000n,
    nativeCurrency: Object.freeze({ name: 'Ether', symbol: 'ETH', decimals: 18 }),
    rpc: Object.freeze({
      default: 'https://mainnet.base.org',
      fallbacks: Object.freeze(['https://base-rpc.publicnode.com'])
    }),
    explorer: Object.freeze({ name: 'BaseScan', url: 'https://basescan.org' })
  })
});

/** All EVM-compatible networks share one derived account (see wallet.js). */
export const EVM_NETWORK_KEYS = Object.freeze(
  Object.values(NETWORKS)
    .filter((network) => network.accountType === ACCOUNT_TYPES.EVM)
    .map((network) => network.key)
);

/**
 * Minimum priority fee (tip) per EVM network in wei (prompt 0231, owner
 * approved: ethereum 1e8, base 1e6, bnb 5e7; testnets explicit too). The
 * fee paths use effective tip = max(endpoint tip, this floor) because a
 * public endpoint answering ~0 is a measured reality (0228 R3: both legs
 * signed with tip 0 and took 3 blocks to land). An unknown or non EVM key
 * THROWS, never a silent default (the getEvmSwapCaps pattern).
 * @returns {bigint}
 */
export function getEvmTipFloorWei(networkKey) {
  const network = NETWORKS[networkKey];
  if (!network || network.accountType !== ACCOUNT_TYPES.EVM || typeof network.tipFloorWei !== 'bigint') {
    throw new Error(`No EVM tip floor is configured for network "${networkKey}".`);
  }
  return network.tipFloorWei;
}

export function getNetwork(key) {
  const network = NETWORKS[key];
  if (!network) {
    throw new Error(`Unknown network: ${key}`);
  }
  return network;
}

export function listNetworks() {
  return Object.values(NETWORKS);
}

/**
 * Returns a new networks map with RPC endpoints overridden, without
 * mutating the frozen defaults. Intended for app-level env/build-time
 * injection, e.g.:
 *   withRpcOverrides({ ethereum: import.meta.env.VITE_ETHEREUM_RPC_URL })
 *
 * The network's own previous default is demoted into `fallbacks` (prepended,
 * ahead of whatever fallbacks already existed) rather than simply discarded
 * (prompt 0130) — an authenticated/private provider like Helius is still a
 * third-party service that can itself go down or rate-limit, and the
 * previously-verified free/public endpoint this file already carries for
 * that network is a reasonable thing to fall back to rather than leaving
 * the network with no fallback at all once an override is applied. Was
 * unused anywhere in the repo before prompt 0130 (grepped to confirm), so
 * this behavior change carries no risk of surprising an existing caller.
 */
export function withRpcOverrides(overrides = {}) {
  const merged = {};
  for (const [key, network] of Object.entries(NETWORKS)) {
    const overrideUrl = overrides[key];
    merged[key] = overrideUrl
      ? { ...network, rpc: { default: overrideUrl, fallbacks: Object.freeze([network.rpc.default, ...network.rpc.fallbacks]) } }
      : network;
  }
  return merged;
}
