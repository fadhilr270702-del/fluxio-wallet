#!/usr/bin/env node
/**
 * Diagnostic tool — hits every RPC endpoint (default + every fallback) for
 * every network in packages/constants/networks.js for real, and prints a
 * PASS/FAIL table. Not part of the app; run manually whenever an endpoint
 * is added/changed/suspected dead:
 *
 *   node scripts/verify-rpc-endpoints.mjs
 *
 * Solana endpoints are checked with getHealth (cheap liveness) and
 * getLatestBlockhash (what transactionService/balanceService actually
 * need in practice); EVM endpoints with eth_blockNumber. An endpoint that
 * fails or requires auth (401/403, or a JSON-RPC error mentioning
 * "unauthorized"/"api key") should be removed from networks.js — this
 * script only reports, it never edits the config itself.
 *
 * A loopback endpoint (127.0.0.1/localhost — e.g. solana-local's local
 * solana-test-validator) is deliberately SKIPPED rather than checked: it
 * only exists while a developer happens to have that validator running on
 * this machine right now, so treating it as a required PASS would make
 * this script fail on every machine/CI run where it isn't — it's reported
 * separately, under its own SKIP section, and never counted in the
 * pass/fail totals.
 *
 * A SECOND section (prompt 0116, see runGtaboEvaluation() below) hits a
 * wider candidate list of free/public Solana mainnet endpoints
 * specifically for getTokenAccountsByOwner, in BOTH a plain request and
 * one carrying a synthetic chrome-extension:// Origin header — this
 * method has its own known gap (see tokenService.js's KNOWN ISSUE
 * comment) independent of whether an endpoint passes the general
 * liveness checks above.
 *
 * A THIRD section (prompt 0130, see runHeliusEvaluation() below) verifies
 * Helius specifically — the actual fix for the KNOWN ISSUE above — for
 * real, against a real Helius API key, rather than trusting Helius's own
 * marketing claims. Reads apps/extension/.env.local's HELIUS_API_KEY (the
 * same file/variable apps/extension/build.mjs injects at build time — see
 * that file's own header comment) and SKIPS this section entirely (not a
 * FAIL) when that file/variable is absent, since a Helius key is optional,
 * personal, and never committed.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NETWORKS } from '../packages/constants/networks.js';
import { ACCOUNT_TYPES } from '../packages/constants/derivationPaths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TIMEOUT_MS = 8000;

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

function isLocalEndpoint(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

async function callRpc(endpoint, method, params) {
  const res = await withTimeout(
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    }),
    TIMEOUT_MS
  );
  const status = res.status;
  let body;
  try {
    body = await res.json();
  } catch {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${status}, non-JSON response: ${text.slice(0, 120)}`);
  }
  if (body?.error) {
    throw new Error(`HTTP ${status}, JSON-RPC error: ${body.error.message || JSON.stringify(body.error)}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${status}`);
  }
  return body.result;
}

async function checkSolanaEndpoint(endpoint) {
  const results = [];
  try {
    const health = await callRpc(endpoint, 'getHealth', []);
    results.push(`getHealth=${JSON.stringify(health)}`);
  } catch (err) {
    return { ok: false, detail: `getHealth failed: ${err.message}` };
  }
  try {
    const blockhash = await callRpc(endpoint, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
    results.push(`getLatestBlockhash=${blockhash?.value?.blockhash?.slice(0, 12)}...`);
  } catch (err) {
    return { ok: false, detail: `getLatestBlockhash failed: ${err.message}` };
  }
  return { ok: true, detail: results.join(', ') };
}

async function checkEvmEndpoint(endpoint) {
  try {
    const blockNumber = await callRpc(endpoint, 'eth_blockNumber', []);
    return { ok: true, detail: `eth_blockNumber=${blockNumber} (${parseInt(blockNumber, 16)})` };
  } catch (err) {
    return { ok: false, detail: `eth_blockNumber failed: ${err.message}` };
  }
}

/**
 * getTokenAccountsByOwner-specific mainnet candidate evaluation (prompt
 * 0116) — a SEPARATE concern from the per-network-config check above.
 * That check only proves an endpoint is alive for getHealth/
 * getLatestBlockhash; this repo's own KNOWN ISSUE (see tokenService.js's
 * header comment) is specifically about ONE method: getTokenAccountsByOwner
 * is a getProgramAccounts-family call, expensive to serve, and several
 * free-tier providers throttle/disable that family outright even on an
 * endpoint where simple methods work fine — and separately, a provider
 * can allow the method in general but reject it specifically for a
 * chrome-extension:// Origin header (confirmed for real, twice now: this
 * is exactly why api.mainnet-beta.solana.com was swapped out as the
 * mainnet default in prompt 0091 originally). Both failure modes are
 * tested here, independently, for every candidate — passing one doesn't
 * imply passing the other.
 *
 * The "owner" address queried is the SPL Token program's own Solana
 * System Program id (11111111111111111111111111111111) — a public,
 * documented-everywhere address, never a real user's own. It holds no
 * SPL token accounts, so an ALLOWED call returns an empty `{value: []}`
 * result — proof the METHOD itself is permitted, nothing about a real
 * holder's data (and nothing that would ever need redacting from this
 * script's own output).
 */
const GTABO_OWNER_ADDRESS = '11111111111111111111111111111111';
const GTABO_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
// A syntactically-plausible extension id (real Chrome extension ids are
// also 32 lowercase a-p characters) — not a real installed extension,
// just close enough in shape to exercise the same origin-based
// allow/block logic a real one would hit.
const GTABO_SYNTHETIC_EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef';

/**
 * Candidate mainnet Solana RPC endpoints evaluated for prompt 0116 — a
 * DELIBERATELY WIDER list than networks.js's own configured
 * default+fallback (which only has one entry for 'solana' today): every
 * free/public endpoint this investigation could find and actually test,
 * not just the ones already wired in. `solana-rpc.publicnode.com` (the
 * CURRENT 'solana' rpc.default) and `api.mainnet-beta.solana.com` (the
 * ORIGINAL default, swapped out in prompt 0091) are both included so
 * their results here are directly comparable to the rest.
 */
const GTABO_CANDIDATES = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://rpc.ankr.com/solana',
  'https://solana.drpc.org',
  'https://solana-mainnet.rpc.extrnode.com',
  'https://api.mngo.cloud/lite-rpc/v1',
  'https://mainnet.rpcpool.com',
  'https://solana-mainnet.g.alchemy.com/v2/demo',
  'https://free.rpcpool.com',
  'https://solana.public-rpc.com',
  'https://api.solscan.io',
  'https://solana-mainnet.core.chainstack.com/demo',
  'https://rpc.magicblock.app',
  'https://solana.leorpc.com/?api_key=FREE',
  'https://endpoints.omniatech.io/v1/sol/mainnet/public',
  'https://solana.blockpi.network/v1/rpc/public'
];

async function checkGtabo(endpoint, origin) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (origin) headers.Origin = origin;
    const res = await withTimeout(
      fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountsByOwner',
          params: [GTABO_OWNER_ADDRESS, { programId: GTABO_TOKEN_PROGRAM_ID }, { encoding: 'jsonParsed' }]
        })
      }),
      TIMEOUT_MS
    );
    const status = res.status;
    let body;
    try {
      body = await res.json();
    } catch {
      const text = await res.text().catch(() => '');
      return { ok: false, detail: `HTTP ${status}, non-JSON response: ${text.slice(0, 100) || '(empty)'}` };
    }
    if (body?.error) {
      return { ok: false, detail: `HTTP ${status}, JSON-RPC error: ${body.error.message || JSON.stringify(body.error)}` };
    }
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${status}` };
    }
    return { ok: true, detail: `HTTP ${status}, value.length=${body.result?.value?.length ?? 'n/a'}` };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

async function runGtaboEvaluation() {
  console.log('\n--- getTokenAccountsByOwner mainnet candidate evaluation (prompt 0116) ---\n');
  const results = [];
  for (const endpoint of GTABO_CANDIDATES) {
    const noOrigin = await checkGtabo(endpoint, null);
    const withOrigin = await checkGtabo(endpoint, GTABO_SYNTHETIC_EXTENSION_ORIGIN);
    const passesBoth = noOrigin.ok && withOrigin.ok;
    results.push({ endpoint, noOrigin, withOrigin, passesBoth });
    console.log(`[${passesBoth ? 'PASS' : 'FAIL'}] ${endpoint}`);
    console.log(`       no-origin:  ${noOrigin.ok ? 'OK  ' : 'FAIL'} — ${noOrigin.detail}`);
    console.log(`       chrome-ext: ${withOrigin.ok ? 'OK  ' : 'FAIL'} — ${withOrigin.detail}\n`);
  }
  const passing = results.filter((r) => r.passesBoth);
  console.log(`${passing.length}/${results.length} candidates pass getTokenAccountsByOwner in BOTH modes (no-origin AND chrome-extension://).`);
  if (!passing.length) {
    console.log(
      'No free/keyless mainnet endpoint tested here allows getTokenAccountsByOwner reliably.\n' +
        "This is reported honestly, not forced — see tokenService.js's own KNOWN ISSUE comment " +
        'and prompt 0116\'s own report for the full context. networks.js is NOT changed as a result ' +
        'of this evaluation; a real fix likely needs a paid RPC provider at mainnet release.'
    );
  } else {
    console.log('Passing candidate(s), worth wiring into networks.js:', passing.map((r) => r.endpoint).join(', '));
  }
  // Deliberately does NOT affect process.exitCode — this is an exploratory
  // evaluation of endpoints NOT currently configured in networks.js
  // (mostly), not a regression check against configured, expected-to-pass
  // endpoints the way the per-network loop above is. A script that exits
  // non-zero every single run because free RPC infrastructure doesn't
  // support this method yet would be noise, not a signal to act on.
  return results;
}

/**
 * Generic single-method, single-origin RPC check (prompt 0130) — a
 * deliberately more general sibling of checkGtabo() above (kept separate
 * rather than refactored into this, to avoid touching the already-working
 * 0116 evaluation for an unrelated prompt), reusable for any method/params
 * pair against any endpoint, with or without a synthetic Origin header.
 */
async function checkRpcMethodWithOrigin(endpoint, method, params, origin) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (origin) headers.Origin = origin;
    const res = await withTimeout(
      fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      }),
      TIMEOUT_MS
    );
    const status = res.status;
    // Node's fetch (undici) exposes every response header regardless of
    // CORS — CORS is enforced by a BROWSER reading these headers, not by
    // the server withholding them from a plain Node caller — so this is a
    // real, direct read of what the server actually sent back, not an
    // approximation. See runHeliusEvaluation()'s own comment for why this
    // matters independently of the JSON-RPC pass/fail result above.
    const acao = res.headers.get('access-control-allow-origin');
    let body;
    try {
      body = await res.json();
    } catch {
      const text = await res.text().catch(() => '');
      return { ok: false, acao, detail: `HTTP ${status}, non-JSON response: ${text.slice(0, 100) || '(empty)'}` };
    }
    if (body?.error) {
      return { ok: false, acao, detail: `HTTP ${status}, JSON-RPC error: ${body.error.message || JSON.stringify(body.error)}` };
    }
    if (!res.ok) {
      return { ok: false, acao, detail: `HTTP ${status}` };
    }
    return { ok: true, acao, detail: `HTTP ${status}, result=${JSON.stringify(body.result).slice(0, 80)}` };
  } catch (err) {
    return { ok: false, acao: null, detail: err.message };
  }
}

/**
 * Helius mainnet Solana RPC evaluation (prompt 0130) — verifies the actual
 * fix for the KNOWN ISSUE tracked in tokenService.js/runGtaboEvaluation()
 * above, against a REAL Helius endpoint with a real key, not assumed from
 * Helius's own documentation. Reads apps/extension/.env.local (the exact
 * same file build.mjs injects HELIUS_API_KEY from) and skips this whole
 * section — reported as SKIP, never a FAIL, matching this script's own
 * existing local-endpoint convention above — when that file/variable is
 * absent, since a Helius key is optional and personal.
 *
 * Tests all three RPC methods this repo's own services actually call
 * against Solana mainnet (tokenService.js's getTokenAccountsByOwner,
 * balanceService.js's getBalance, historyService.js's
 * getSignaturesForAddress), each in BOTH a plain request and one carrying
 * a synthetic chrome-extension:// Origin header — exactly the same
 * dual-mode methodology as runGtaboEvaluation() above, since an endpoint
 * passing a plain Node-style request proves nothing about whether it
 * blocks the one real caller that matters (the packaged extension's own
 * background.js). The owner/address used for every call is the same
 * public Solana System Program id runGtaboEvaluation() already uses
 * above — never a real user's own address.
 */
async function runHeliusEvaluation() {
  const envLocalPath = path.join(__dirname, '..', 'apps', 'extension', '.env.local');
  if (existsSync(envLocalPath)) {
    try {
      process.loadEnvFile(envLocalPath);
    } catch (err) {
      console.log(`\n--- Helius mainnet RPC evaluation (prompt 0130) ---\n[SKIP] Could not read ${envLocalPath}: ${err.message}\n`);
      return null;
    }
  }
  const apiKey = process.env.HELIUS_API_KEY || '';
  console.log('\n--- Helius mainnet RPC evaluation (prompt 0130) ---\n');
  if (!apiKey) {
    console.log(
      '[SKIP] No HELIUS_API_KEY found (apps/extension/.env.local missing or empty) — this is optional ' +
        'and personal, not a failure. See apps/extension/.env.example for how to set one up, then re-run ' +
        'this script to verify it for real against your own key.\n'
    );
    return null;
  }

  const endpoint = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const methods = [
    {
      name: 'getTokenAccountsByOwner',
      params: [GTABO_OWNER_ADDRESS, { programId: GTABO_TOKEN_PROGRAM_ID }, { encoding: 'jsonParsed' }]
    },
    { name: 'getBalance', params: [GTABO_OWNER_ADDRESS] },
    { name: 'getSignaturesForAddress', params: [GTABO_OWNER_ADDRESS, { limit: 1 }] }
  ];

  const results = [];
  for (const { name, params } of methods) {
    const noOrigin = await checkRpcMethodWithOrigin(endpoint, name, params, null);
    const withOrigin = await checkRpcMethodWithOrigin(endpoint, name, params, GTABO_SYNTHETIC_EXTENSION_ORIGIN);
    const passesBoth = noOrigin.ok && withOrigin.ok;
    results.push({ method: name, noOrigin, withOrigin, passesBoth });
    console.log(`[${passesBoth ? 'PASS' : 'FAIL'}] ${name}`);
    console.log(`       no-origin:  ${noOrigin.ok ? 'OK  ' : 'FAIL'} — ${noOrigin.detail}`);
    console.log(`       chrome-ext: ${withOrigin.ok ? 'OK  ' : 'FAIL'} — ${withOrigin.detail}`);
    console.log(`       Access-Control-Allow-Origin header (chrome-ext request): ${withOrigin.acao ?? '(absent)'}\n`);
  }
  const passing = results.filter((r) => r.passesBoth);
  console.log(`${passing.length}/${results.length} methods pass on Helius in BOTH modes (no-origin AND chrome-extension://).`);
  if (passing.length === results.length) {
    console.log('All 3 methods this repo actually calls against Solana mainnet pass on Helius — the prompt 0116 known issue is resolved for this key.');
  } else {
    console.log(
      'At least one method failed against Helius with this key — do NOT assume the prompt 0116 known issue ' +
        'is resolved; see the per-method detail above.'
    );
  }

  // CORS/host_permissions check (prompt 0130 Revision 1) — a genuinely
  // SEPARATE failure layer from the JSON-RPC pass/fail above, and one a
  // Node-based check like this script's own `fetch` calls CANNOT prove
  // fully on its own: Node's fetch does not enforce CORS at all (CORS is
  // a BROWSER security feature — the server sends the same headers to
  // every caller regardless), so a Node "PASS" above only proves Helius
  // ANSWERS the request; it says nothing about whether a REAL Chrome
  // extension's background service worker would be permitted to READ
  // that answer. Two ways a real browser fetch to a host NOT listed in
  // manifest.json's host_permissions can still succeed end-to-end: (a)
  // the server's own Access-Control-Allow-Origin header is `*` or
  // otherwise matches the request's chrome-extension:// origin, or (b)
  // the host is listed in host_permissions, which grants MV3's own
  // CORS-bypass for that host regardless of what the server sends
  // (exactly why lite-api.jup.ag/api.coingecko.com are listed there —
  // prompt 0115/0118 precedent). Checking (a) here for real rather than
  // assuming it, since assuming it wrong would mean the wiring fix in
  // this prompt still fails in real Chrome from a SECOND, different
  // cause than the one just fixed.
  const acaoValues = [...new Set(results.map((r) => r.withOrigin.acao).filter((v) => v != null))];
  console.log('\n--- CORS check: Access-Control-Allow-Origin, real header values seen from Helius ---');
  console.log(acaoValues.length ? acaoValues.join(', ') : '(no ACAO header present on any response)');
  const corsLooksPermissive = acaoValues.some((v) => v === '*' || v.startsWith('chrome-extension://'));
  if (corsLooksPermissive) {
    console.log(
      'Permissive (matches "*" or a chrome-extension:// origin) — a real browser fetch from the extension ' +
        'should succeed without needing a host_permissions entry, same as the existing public RPC endpoints ' +
        '(none of which are listed in manifest.json either).'
    );
  } else {
    console.log(
      'NOT clearly permissive for a chrome-extension:// origin — a real browser fetch could be blocked by ' +
        'CORS even though this Node-based check passed. Recommend adding "https://mainnet.helius-rpc.com/*" ' +
        'to manifest.json\'s host_permissions (same precedent as lite-api.jup.ag/api.coingecko.com) so MV3\'s ' +
        'own CORS-bypass covers it regardless of what Helius\'s CORS header actually says.'
    );
  }
  // Same reasoning as runGtaboEvaluation(): this is a diagnostic report
  // about a specific, personal, optional API key, never a required
  // regression gate — never affects process.exitCode.
  return results;
}

async function main() {
  const rows = [];
  const skipped = [];
  for (const network of Object.values(NETWORKS)) {
    const endpoints = [
      { url: network.rpc.default, role: 'default' },
      ...network.rpc.fallbacks.map((url) => ({ url, role: 'fallback' }))
    ];
    for (const { url, role } of endpoints) {
      if (isLocalEndpoint(url)) {
        skipped.push({ network: network.key, role, url });
        continue;
      }
      const check = network.accountType === ACCOUNT_TYPES.SOLANA ? checkSolanaEndpoint : checkEvmEndpoint;
      const result = await check(url);
      rows.push({ network: network.key, role, url, ...result });
    }
  }

  console.log('\n--- RPC endpoint verification ---\n');
  for (const row of rows) {
    const status = row.ok ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${row.network.padEnd(18)} (${row.role.padEnd(8)}) ${row.url}`);
    console.log(`       ${row.detail}\n`);
  }

  if (skipped.length) {
    console.log('--- Skipped: local-only endpoints (only reachable while a local validator is running) ---\n');
    skipped.forEach((s) => console.log(`[SKIP] ${s.network.padEnd(18)} (${s.role.padEnd(8)}) ${s.url}`));
    console.log('');
  }

  const failures = rows.filter((r) => !r.ok);
  console.log(
    `${rows.length - failures.length}/${rows.length} endpoints passed` +
      (skipped.length ? ` (${skipped.length} local-only endpoint(s) skipped, not counted).` : '.')
  );
  if (failures.length) {
    console.log('\nFAILED endpoints (should be removed/replaced in networks.js):');
    failures.forEach((f) => console.log(`  - ${f.network} (${f.role}): ${f.url} — ${f.detail}`));
    process.exitCode = 1;
  }

  await runGtaboEvaluation();
  await runHeliusEvaluation();
}

main().catch((err) => {
  console.error('Verification script crashed:', err);
  process.exitCode = 1;
});
