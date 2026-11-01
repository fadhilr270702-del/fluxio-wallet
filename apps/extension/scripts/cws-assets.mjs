/**
 * Generates the Chrome Web Store listing image assets (prompt 0184):
 *   docs/release/assets/screenshot-{1..5}-*.png  — exactly 1280x800 each
 *   docs/release/assets/small-promo-tile-440x280.png — exactly 440x280
 *   docs/release/assets/marquee-1400x560.png — exactly 1400x560 (optional CWS field)
 *
 * Every screenshot shows the REAL extension UI — a headless Chromium
 * browser (Edge preferred, Chrome fallback — Google Chrome branded builds
 * dropped --load-extension support around v137, so Edge is tried first
 * and the script verifies the extension genuinely loaded before
 * proceeding) loads the actual unpacked extension from apps/extension/,
 * a throwaway TEST wallet is created through the real
 * FLUXIO_INTERNAL_* message flow (a fresh mnemonic generated in that
 * headless profile — never the owner's seed, never persisted anywhere
 * beyond the temp profile that is deleted at the end), the notifications
 * inbox is populated by injecting a realistic cached state into
 * chrome.storage.local (NOTIFICATIONS_STATE_STORAGE_KEY — no backend is
 * ever started; lastFetchedAt is set to "now" so the popup's own
 * throttle window suppresses any real fetch), and each screen is
 * captured over CDP (raw WebSocket on Node's built-in global WebSocket,
 * same no-new-dependency approach as prompts 0179/0181), then composed
 * onto a brand background via the templates in docs/release/assets/src/
 * and re-captured at the exact CWS pixel size.
 *
 * Hard guarantees:
 *  - every output PNG's dimensions are read back from its own IHDR
 *    header (scripts/pngDimensions.mjs) and the script exits nonzero on
 *    any mismatch — never "probably the right size";
 *  - no visible text placed by this script or its templates contains a
 *    "-" character (owner's public-content rule; periods/spaces instead);
 *  - the browser is killed by the exact PID this script spawned, never
 *    by image name (CLAUDE.md's standing process-hygiene rule), and its
 *    temp profile + work dir are deleted afterward.
 *
 * Run from the repo root:  node apps/extension/scripts/cws-assets.mjs
 * (requires background.bundle.js to exist — run `pnpm build:extension`
 * first; the dev bundle is fine, no backend is contacted for these shots).
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readPngDimensions } from './pngDimensions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(EXT_ROOT, '..', '..');
const ASSETS_DIR = path.join(REPO_ROOT, 'docs', 'release', 'assets');
const SRC_DIR = path.join(ASSETS_DIR, 'src');

const BROWSER_CANDIDATES = [
  process.env.FLUXIO_CWS_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);

const TEST_WALLET_PASSWORD = 'FluxioListingShots2026'; // throwaway, headless profile only

// --- CLI (prompt 0204) --------------------------------------------------
// Default (no flags): the full pipeline, exactly as before — all five
// screenshots + promo tile + marquee. `--only=swap,marquee` regenerates
// just those outputs (the shared setup — wallet creation, and the raw
// dashboard capture the marquee composes over — still runs; the OTHER
// output files are simply never written, so they stay byte-identical).
// `--marquee-candidates=<dir>` (only meaningful with marquee selected)
// renders the two prompt-0204 tagline candidates into <dir> INSTEAD of
// writing docs/release/assets/marquee-1400x560.png — a one-shot compare
// mode for the owner's pick; once the template's own tagline is updated
// to the chosen text, this mode's replacement key no longer matches and
// the flag should be retired.
const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean) : null;
if (ONLY) {
  for (const item of ONLY) {
    if (!['swap', 'marquee', 'send'].includes(item)) throw new Error(`--only supports swap,marquee,send — got "${item}"`);
  }
}
const want = (k) => !ONLY || ONLY.includes(k);
const marqueeCandidatesArg = argv.find((a) => a.startsWith('--marquee-candidates='));
const MARQUEE_CANDIDATES_DIR = marqueeCandidatesArg ? marqueeCandidatesArg.slice('--marquee-candidates='.length) : null;
// `--swap-shot-out=<dir>` (prompt 0205): compose screenshot-3-swap.png
// into <dir> INSTEAD of docs/release/assets — a proof-run mode, so a
// future-behavior check can render the swap shot without touching the
// repo's committed store asset.
const swapShotOutArg = argv.find((a) => a.startsWith('--swap-shot-out='));
const SWAP_SHOT_OUT_DIR = swapShotOutArg ? swapShotOutArg.slice('--swap-shot-out='.length) : null;
// `--send-shot-out=<dir>` (prompt 0207): same proof-run mode for
// screenshot-2-send — compose into <dir> instead of docs/release/assets.
const sendShotOutArg = argv.find((a) => a.startsWith('--send-shot-out='));
const SEND_SHOT_OUT_DIR = sendShotOutArg ? sendShotOutArg.slice('--send-shot-out='.length) : null;
// The tagline exactly as WRITTEN IN marquee-template.html — used only as
// the replacement KEY when composing marquee CANDIDATES (each candidate's
// text replaces this string in the template). Renamed and re-synced in
// prompt 0207: the old constant still held the pre-0204 tagline
// ("…Free transfers, forever.") while the template had long since moved
// to M1, so the candidates path's tagline replacement had become a
// silent no-op. Kept (not deleted) because the candidates mode genuinely
// needs a replacement key; if the template's tagline ever changes again,
// change this constant with it.
const MARQUEE_TEMPLATE_TAGLINE = 'Non custodial wallet. Solana and EVM. Swap on Solana. No added fee on transfers.';
const MARQUEE_CANDIDATES = {
  M1: 'Non custodial wallet. Solana and EVM. Swap on Solana. No added fee on transfers.',
  M2: 'Non custodial wallet. Solana and EVM. No added fee on transfers.'
};

const workDir = path.join(os.tmpdir(), `fluxio-cws-assets-${Date.now()}`);
mkdirSync(workDir, { recursive: true });

function fileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
}
const LOGO_URL = fileUrl(path.join(EXT_ROOT, 'icons', 'icon128.png'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Minimal CDP client on Node's built-in WebSocket (no dependency)
// ---------------------------------------------------------------------------
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${msg.error.message}${msg.error.data ? ` — ${msg.error.data}` : ''}`));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

async function connectWebSocket(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`WebSocket connect failed: ${url}`)), { once: true });
  });
  return ws;
}

// ---------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------
async function launchBrowser(browserPath, profileDir) {
  mkdirSync(profileDir, { recursive: true });
  const args = [
    `--user-data-dir=${profileDir}`,
    '--headless',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--remote-debugging-port=0',
    `--load-extension=${EXT_ROOT}`,
    `--disable-extensions-except=${EXT_ROOT}`,
    '--window-size=1440,960',
    'about:blank'
  ];
  const proc = spawn(browserPath, args, { stdio: 'ignore' });
  console.log(`[cws-assets] launched ${path.basename(browserPath)} PID ${proc.pid}`);

  // --remote-debugging-port=0 writes the chosen port to DevToolsActivePort
  // inside the profile dir — poll for it rather than guessing a port.
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  for (let i = 0; i < 60; i++) {
    if (existsSync(portFile)) break;
    await sleep(250);
  }
  if (!existsSync(portFile)) {
    proc.kill();
    throw new Error('DevToolsActivePort never appeared — browser failed to start headless.');
  }
  const [port, wsPath] = readFileSync(portFile, 'utf8').trim().split('\n');
  const ws = await connectWebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  return { proc, cdp: new Cdp(ws), ws };
}

/**
 * Finds FLUXIO's extension id via its own service worker target — matched
 * on the bundle path, NOT just any chrome-extension:// URL: Edge ships
 * internal component extensions whose targets would otherwise match first
 * (found the hard way — the first run picked up an Edge-internal id and
 * every subsequent page open 404'd). Returns null when Fluxio's worker
 * never appears (e.g. a branded build that dropped --load-extension).
 */
async function findExtensionId(cdp) {
  let lastTargets = [];
  for (let i = 0; i < 40; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    lastTargets = targetInfos;
    const ext = targetInfos.find(
      (t) => t.url.startsWith('chrome-extension://') && t.url.includes('/background/background.bundle.js')
    );
    if (ext) return new URL(ext.url).host;
    await sleep(250);
  }
  console.log('[cws-assets] targets seen while waiting for the Fluxio service worker:');
  for (const t of lastTargets) console.log(`  ${t.type}: ${t.url}`);
  return null;
}

// ---------------------------------------------------------------------------
// Page session helpers
// ---------------------------------------------------------------------------
async function openPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  return { targetId, sessionId };
}

async function evaluate(cdp, sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (exceptionDetails) {
    throw new Error(`page evaluate failed: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
  }
  return result?.value;
}

async function waitFor(cdp, sessionId, expr, { timeoutMs = 20000, label = expr } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, sessionId, `!!(${expr})`)) return true;
    } catch {
      // page may be mid-navigation — keep polling until the deadline
    }
    await sleep(250);
  }
  let snapshot = '';
  try {
    snapshot = await evaluate(
      cdp,
      sessionId,
      `document.readyState + ' | ' + location.href + ' | ' + (document.body ? document.body.innerHTML.replace(/\\s+/g, ' ').slice(0, 500) : '(no body)')`
    );
  } catch (err) {
    snapshot = `(no DOM snapshot: ${err.message})`;
  }
  throw new Error(`timeout waiting for: ${label}\n  page state: ${snapshot}`);
}

/** Same polling loop but non-fatal — for nice-to-have settle states (e.g. a live quote) where the honest fallback is simply capturing what IS on screen. */
async function waitForOptional(cdp, sessionId, expr, opts = {}) {
  try {
    await waitFor(cdp, sessionId, expr, opts);
    return true;
  } catch {
    console.log(`[cws-assets] optional wait skipped (${opts.label || expr}) — capturing current state.`);
    return false;
  }
}

async function setViewport(cdp, sessionId, width, height, deviceScaleFactor) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false }, sessionId);
}

async function capture(cdp, sessionId, outPath) {
  await sleep(350); // let fonts/last paint settle
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
  const bytes = Buffer.from(data, 'base64');
  writeFileSync(outPath, bytes);
  return readPngDimensions(new Uint8Array(bytes));
}

const SEND_HELPER = `
  window.__send = (type, extra = {}) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (result) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (result && result.error) return reject(new Error(result.error));
      resolve(result && result.response);
    });
  }); true;
`;

/** Sets an input's value and fires a real 'input' event so the page's own live listeners run. */
function setInputExpr(id, value) {
  return `(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------
async function compose(cdp, { template, replacements, width, height, outName, outDir = ASSETS_DIR }) {
  let html = readFileSync(path.join(SRC_DIR, template), 'utf8');
  for (const [key, value] of Object.entries({ __LOGO_SRC__: LOGO_URL, ...replacements })) {
    html = html.split(key).join(value);
  }
  const pagePath = path.join(workDir, `${outName}.html`);
  writeFileSync(pagePath, html);

  const page = await openPage(cdp, fileUrl(pagePath));
  await setViewport(cdp, page.sessionId, width, height, 1);
  await waitFor(cdp, page.sessionId, `document.readyState === 'complete' && Array.from(document.images).every((i) => i.complete && i.naturalWidth > 0)`, { label: `${outName} images loaded` });
  const outPath = path.join(outDir, `${outName}.png`);
  const dims = await capture(cdp, page.sessionId, outPath);
  await cdp.send('Target.closeTarget', { targetId: page.targetId });
  if (dims.width !== width || dims.height !== height) {
    throw new Error(`${outName}.png is ${dims.width}x${dims.height}, expected exactly ${width}x${height}`);
  }
  console.log(`[cws-assets] wrote ${outName}.png (${dims.width}x${dims.height}, verified from IHDR)`);
  return { file: `${outName}.png`, outDir, ...dims };
}

// ---------------------------------------------------------------------------
// Service-worker swap mock (prompt 0204 — the 0200 in-SW-mock pattern)
// ---------------------------------------------------------------------------
// The swap screenshot shows the REVIEW screen with the real "Fluxio fee
// (0.85%)" row, deterministically: the service worker's own fetch is
// wrapped so Jupiter (token list, quote, build) and the two Solana RPC
// methods the flow touches (getBalance — so the throwaway wallet shows a
// plausible 1.2 SOL balance — and getTokenAccountsByOwner) all answer
// with fixed, mathematically consistent numbers, and EVERY other
// outbound request is blocked (thrown) and logged. Numbers:
//   in 0.5 SOL = 500,000,000 raw; gross out 48,600,000 raw USDC;
//   platformFee = floor(48,600,000 × 85 / 10,000) = 413,100 (0.4131 USDC);
//   net outAmount = 48,186,900 (48.1869 USDC);
//   minReceived = floor(48,186,900 × 0.995) = 47,945,965 (50 bps);
//   network fee = 5,000 base + 95,000 prioritization = 100,000 lamports.
// A reviewer can recompute 413,100 / 48,600,000 = exactly 0.85%.
const SW_SWAP_MOCK_SOURCE = `
(() => {
  if (globalThis.__CWS_SHOT_MOCK__) return 'already-installed';
  globalThis.__CWS_SHOT_MOCK__ = { requests: [] };
  const SOL = 'So11111111111111111111111111111111111111112';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const QUOTE = {
    inputMint: SOL, inAmount: '500000000',
    outputMint: USDC, outAmount: '48186900',
    otherAmountThreshold: '47945965',
    swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0.01', routePlan: [],
    platformFee: { amount: '413100', feeBps: 85 }
  };
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : input.url);
    // Log/throw HOSTNAME ONLY — never the full URL or query string: the
    // Helius RPC URL carries the API key in its query, and these strings
    // end up in the script's own stdout and in thrown error messages.
    let entry;
    try { entry = new URL(url).hostname; } catch { entry = 'invalid-url'; }
    if (url.startsWith('https://lite-api.jup.ag/tokens/v2/tag')) {
      globalThis.__CWS_SHOT_MOCK__.requests.push(entry + ' [mocked]');
      return json([
        { address: SOL, symbol: 'SOL', name: 'Wrapped SOL', decimals: 9, logoURI: null },
        { address: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: null }
      ]);
    }
    if (url.startsWith('https://lite-api.jup.ag/swap/v1/quote')) {
      globalThis.__CWS_SHOT_MOCK__.requests.push(entry + ' [mocked]');
      return json(QUOTE);
    }
    if (url.startsWith('https://lite-api.jup.ag/swap/v1/swap')) {
      globalThis.__CWS_SHOT_MOCK__.requests.push(entry + ' [mocked]');
      // A REAL (unsigned, never-broadcast) Jupiter build fixture with NO
      // output-ATA create instruction (prompt 0205): PREVIEW parses the
      // build for the rent row now, so the mock must be deserializable —
      // and this fixture keeps the store screenshot rent-row-free (the
      // detection derives the throwaway wallet's own candidate ATAs,
      // which a fixture built for another address never references).
      return json({ swapTransaction: '__BUILD_TX_B64__', prioritizationFeeLamports: 95000, computeUnitLimit: 1400000, lastValidBlockHeight: 1000 });
    }
    if (init && init.body) {
      try {
        const { method } = JSON.parse(init.body);
        entry += ' [rpc:' + method + ']';
        if (method === 'getBalance') {
          globalThis.__CWS_SHOT_MOCK__.requests.push(entry + ' [mocked]');
          return json({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: 1200000000 } });
        }
        if (method === 'getTokenAccountsByOwner') {
          globalThis.__CWS_SHOT_MOCK__.requests.push(entry + ' [mocked]');
          return json({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: [] } });
        }
        if (method === 'getMinimumBalanceForRentExemption') {
          // The chain's real 165-byte figure as of 18 September 2026.
          globalThis.__CWS_SHOT_MOCK__.requests.push(entry + ' [mocked]');
          return json({ jsonrpc: '2.0', id: 1, result: 1488440 });
        }
      } catch {}
    }
    globalThis.__CWS_SHOT_MOCK__.requests.push(entry + ' [BLOCKED]');
    // Hostname only here too — this message surfaces in caller error
    // paths and logs, so the full URL (query string included) must
    // never ride along.
    throw new Error('cws-assets swap mock: outbound request blocked during capture: ' + entry);
  };
  return 'installed';
})()
`;

/** The no-ATA Jupiter build fixture backing the swap mock above — read from the services test fixtures so the two stay one source of truth. */
function swapMockSourceWithBuildTx() {
  const fixture = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'packages', 'services', 'test', 'fixtures', 'build-fixture-sol-to-usdc-existing.json'), 'utf8')
  );
  return SW_SWAP_MOCK_SOURCE.replace('__BUILD_TX_B64__', fixture.swapTransactionBase64);
}

/** Attaches to the extension's own service-worker target and evaluates `expression` there. */
async function evaluateInServiceWorker(cdp, expression) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const sw = targetInfos.find(
    (t) => t.url.startsWith('chrome-extension://') && t.url.includes('/background/background.bundle.js')
  );
  if (!sw) throw new Error('Fluxio service-worker target not found for the swap mock.');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (exceptionDetails) {
    throw new Error(`service-worker evaluate failed: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
  }
  return result?.value;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!existsSync(path.join(EXT_ROOT, 'background', 'background.bundle.js'))) {
    throw new Error('background.bundle.js missing — run `pnpm build:extension` first.');
  }
  mkdirSync(ASSETS_DIR, { recursive: true });

  // --- launch: first candidate whose extension target actually appears ---
  let browser = null;
  let extId = null;
  for (const candidate of BROWSER_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    const profileDir = path.join(workDir, `profile-${path.basename(candidate, '.exe')}`);
    const attempt = await launchBrowser(candidate, profileDir);
    extId = await findExtensionId(attempt.cdp);
    if (extId) {
      browser = attempt;
      console.log(`[cws-assets] extension loaded in ${path.basename(candidate)} — id ${extId}`);
      break;
    }
    console.log(`[cws-assets] ${path.basename(candidate)} did not load the extension (branded builds may have dropped --load-extension) — killing PID ${attempt.proc.pid} and trying the next candidate.`);
    attempt.proc.kill();
    await sleep(500);
  }
  if (!browser) {
    throw new Error('No available browser loaded the unpacked extension headless. Set FLUXIO_CWS_BROWSER to a Chromium binary that still supports --load-extension.');
  }
  const { proc, cdp } = browser;

  const results = [];
  try {
    // --- 1. onboarding welcome screen (BEFORE any wallet exists) ---
    // The page itself is always needed (the throwaway wallet is created
    // through it); the CAPTURE only when screenshot-5 will be written.
    const ob = await openPage(cdp, `chrome-extension://${extId}/onboarding/onboarding.html`);
    // 620x520, not the page's real full-tab proportions: the welcome card
    // is small and vertically centered, so a taller viewport just frames
    // dead space around it in the composed shot.
    await setViewport(cdp, ob.sessionId, 620, 520, 2);
    await waitFor(cdp, ob.sessionId, `document.getElementById('createBtn')`, { label: 'onboarding welcome' });
    const rawOnboarding = path.join(workDir, 'raw-onboarding.png');
    if (!ONLY) {
      await capture(cdp, ob.sessionId, rawOnboarding);
      console.log('[cws-assets] captured raw onboarding screen');
    }

    // --- 2. create the throwaway TEST wallet + inject inbox state ---
    await evaluate(cdp, ob.sessionId, SEND_HELPER);
    const mnemonic = await evaluate(cdp, ob.sessionId, `__send('FLUXIO_INTERNAL_GENERATE_MNEMONIC', { wordCount: 12 }).then((r) => r.mnemonic)`);
    await evaluate(cdp, ob.sessionId, `__send('FLUXIO_INTERNAL_IMPORT_WALLET', { mnemonic: ${JSON.stringify(mnemonic)}, password: ${JSON.stringify(TEST_WALLET_PASSWORD)} }).then(() => true)`);
    let status = await evaluate(cdp, ob.sessionId, `__send('FLUXIO_INTERNAL_GET_STATUS')`);
    if (!status.isUnlocked) {
      await evaluate(cdp, ob.sessionId, `__send('FLUXIO_INTERNAL_UNLOCK', { password: ${JSON.stringify(TEST_WALLET_PASSWORD)} }).then(() => true)`);
      status = await evaluate(cdp, ob.sessionId, `__send('FLUXIO_INTERNAL_GET_STATUS')`);
    }
    const solAddress = status?.wallet?.accounts?.solana?.address;
    if (!solAddress) throw new Error('test wallet creation failed — no Solana address in GET_STATUS.');
    console.log('[cws-assets] throwaway test wallet created and unlocked');

    // Injected inbox state: realistic copy, none of it containing "-"
    // (it appears verbatim in a published screenshot). lastFetchedAt =
    // now, so GET_NOTIFICATIONS's own 5 minute throttle serves exactly
    // this cache instead of attempting any real fetch — no backend runs.
    const now = Date.now();
    const iso = (msAgo) => new Date(now - msAgo).toISOString();
    const notifState = {
      announcements: [
        { id: 'shot1', level: 'info', title: 'Welcome to Fluxio', body: 'Thanks for being early. Your feedback shapes what we build next.', titleFormat: 'plain', bodyFormat: 'plain', startsAt: iso(2 * 3600e3), firstSeenAt: now - 2 * 3600e3 },
        { id: 'shot2', level: 'info', title: 'Swap quotes on Solana', body: 'Real time quotes via Jupiter are now built in. Open Swap to try it.', titleFormat: 'plain', bodyFormat: 'plain', startsAt: iso(26 * 3600e3), firstSeenAt: now - 26 * 3600e3 },
        { id: 'shot3', level: 'warning', title: 'Stay safe out there', body: 'We will never DM you first or ask for your seed phrase. No one legitimate ever will.', titleFormat: 'plain', bodyFormat: 'plain', startsAt: iso(3 * 86400e3), firstSeenAt: now - 3 * 86400e3 }
      ],
      readIds: ['shot3'],
      lastFetchedAt: now
    };
    await evaluate(cdp, ob.sessionId, `chrome.storage.local.set({ fluxio_notifications_state: ${JSON.stringify(notifState)} }).then(() => true)`);
    await cdp.send('Target.closeTarget', { targetId: ob.targetId });

    // --- 3. popup dashboard ---
    const pp = await openPage(cdp, `chrome-extension://${extId}/popup/popup.html`);
    await setViewport(cdp, pp.sessionId, 375, 600, 2);
    await waitFor(cdp, pp.sessionId, `document.getElementById('actionSend')`, { label: 'wallet ready screen', timeoutMs: 30000 });
    // real balance fetches against public RPCs — wait for the skeletons to
    // resolve (best effort: a slow RPC row still shows honest UI).
    await waitForOptional(cdp, pp.sessionId, `document.querySelectorAll('.skeleton').length === 0`, { timeoutMs: 30000, label: 'balances settled' });
    const rawDashboard = path.join(workDir, 'raw-dashboard.png');
    await capture(cdp, pp.sessionId, rawDashboard);
    console.log('[cws-assets] captured raw dashboard');

    // --- 4. send flow: network picker -> Solana -> native asset -> form ---
    const rawSend = path.join(workDir, 'raw-send.png');
    if (want('send')) {
      await evaluate(cdp, pp.sessionId, `document.getElementById('actionSend').click(); true;`);
      await waitFor(cdp, pp.sessionId, `document.getElementById('pick-solana')`, { label: 'send network picker' });
      await evaluate(cdp, pp.sessionId, `document.getElementById('pick-solana').click(); true;`);
      await waitFor(cdp, pp.sessionId, `document.getElementById('asset-native')`, { label: 'send asset picker', timeoutMs: 30000 });
      await evaluate(cdp, pp.sessionId, `document.getElementById('asset-native').click(); true;`);
      await waitFor(cdp, pp.sessionId, `document.getElementById('toInput')`, { label: 'send form', timeoutMs: 30000 });
      // Recipient: the test wallet's own (valid) address — live validation
      // stays clean; amount deliberately left on its 0.00 placeholder so no
      // "exceeds balance" error can appear in the shot (balance is 0).
      await evaluate(cdp, pp.sessionId, setInputExpr('toInput', solAddress));
      await capture(cdp, pp.sessionId, rawSend);
      console.log('[cws-assets] captured raw send form');
    }

    // --- 5. swap on Solana: the REVIEW screen with the real "Fluxio fee
    // (0.85%)" row, fully deterministic (prompt 0204) — the service
    // worker's fetch is mocked FIRST (see SW_SWAP_MOCK_SOURCE above), so
    // Jupiter and the balance RPCs answer fixed numbers and nothing else
    // can leave the machine during this capture. Installed AFTER the
    // dashboard capture on purpose: the dashboard shot keeps its real
    // (zero-balance) RPC fetches, exactly as before.
    const rawSwap = path.join(workDir, 'raw-swap.png');
    if (want('swap')) {
      const mockState = await evaluateInServiceWorker(cdp, swapMockSourceWithBuildTx());
      console.log(`[cws-assets] swap mock in service worker: ${mockState}`);
      await cdp.send('Page.navigate', { url: `chrome-extension://${extId}/popup/popup.html` }, pp.sessionId);
      await waitFor(cdp, pp.sessionId, `document.getElementById('actionSwap')`, { label: 'wallet ready (again)', timeoutMs: 30000 });
      await evaluate(cdp, pp.sessionId, `document.getElementById('actionSwap').click(); true;`);
      await waitFor(cdp, pp.sessionId, `document.getElementById('swap-pick-solana')`, { label: 'swap network picker' });
      await evaluate(cdp, pp.sessionId, `document.getElementById('swap-pick-solana').click(); true;`);
      await waitFor(cdp, pp.sessionId, `document.getElementById('payAmountInput')`, { timeoutMs: 30000, label: 'swap screen (mocked token list)' });
      await evaluate(cdp, pp.sessionId, `document.getElementById('receiveAssetBtn').click(); true;`);
      await waitFor(cdp, pp.sessionId, `document.getElementById('tokenSearchInput')`, { label: 'receive token picker' });
      await evaluate(cdp, pp.sessionId, setInputExpr('tokenSearchInput', 'usdc'));
      await waitFor(cdp, pp.sessionId, `document.getElementById('receive-token-0')`, { timeoutMs: 8000, label: 'usdc search result' });
      await evaluate(cdp, pp.sessionId, `document.getElementById('receive-token-0').click(); true;`);
      await waitFor(cdp, pp.sessionId, `document.getElementById('payAmountInput')`, { label: 'swap screen with receive asset', timeoutMs: 30000 });
      await evaluate(cdp, pp.sessionId, setInputExpr('payAmountInput', '0.5'));
      await waitFor(cdp, pp.sessionId, `!document.getElementById('reviewBtn').disabled`, { timeoutMs: 15000, label: 'mocked quote enables Review' });
      await evaluate(cdp, pp.sessionId, `document.getElementById('reviewBtn').click(); true;`);
      await waitFor(cdp, pp.sessionId, `document.getElementById('confirmSwapBtn')`, { label: 'Review screen', timeoutMs: 15000 });
      await waitFor(cdp, pp.sessionId, `document.body.textContent.includes('Fluxio fee (0.85%)')`, { label: 'Fluxio fee row', timeoutMs: 15000 });
      // Prompt 0206 replaced the live-preview fee value (#networkFeeValue)
      // with a STATIC "Network fee (max)" ceiling row (base 5000 + the
      // 150000 lamport priority cap = 0.000155 SOL, no "~") — wait for
      // that exact text instead of the removed element id.
      await waitFor(
        cdp,
        pp.sessionId,
        `document.body.textContent.includes('Network fee (max)') && document.body.textContent.includes('0.000155 SOL')`,
        { label: 'static Network fee (max) row', timeoutMs: 15000 }
      );
      await capture(cdp, pp.sessionId, rawSwap);
      console.log('[cws-assets] captured raw swap REVIEW screen (mocked, deterministic)');
      const mockLog = await evaluateInServiceWorker(cdp, 'globalThis.__CWS_SHOT_MOCK__ ? globalThis.__CWS_SHOT_MOCK__.requests : null');
      console.log('[cws-assets] requests observed by the swap mock during the flow:');
      for (const r of mockLog || []) console.log(`  ${r}`);
    }

    // --- 6. notifications inbox (the injected state) ---
    const rawNotifications = path.join(workDir, 'raw-notifications.png');
    if (!ONLY) {
      await cdp.send('Page.navigate', { url: `chrome-extension://${extId}/popup/popup.html` }, pp.sessionId);
      await waitFor(cdp, pp.sessionId, `document.getElementById('actionNotifications')`, { label: 'wallet ready (again)', timeoutMs: 30000 });
      await evaluate(cdp, pp.sessionId, `document.getElementById('actionNotifications').click(); true;`);
      await waitFor(cdp, pp.sessionId, `document.querySelector('.notif-item')`, { label: 'notifications list', timeoutMs: 15000 });
      await capture(cdp, pp.sessionId, rawNotifications);
      console.log('[cws-assets] captured raw notifications inbox');
    }
    await cdp.send('Target.closeTarget', { targetId: pp.targetId });

    // --- 7. compose the final CWS sized assets ---
    // Titles/subtitles: owner's rule — no "-" anywhere (so "ERC20", not the hyphenated form).
    const screenshotPlan = [
      ...(!ONLY ? [{ outName: 'screenshot-1-dashboard', raw: rawDashboard, title: 'Your keys. Your crypto.', subtitle: 'A non custodial wallet for Solana and EVM chains.', shotHeight: 640 }] : []),
      ...(want('send') ? [{ outName: 'screenshot-2-send', raw: rawSend, title: 'Send in seconds', subtitle: 'SOL, ETH, SPL and ERC20 tokens. Fluxio adds no fee on transfers.', shotHeight: 640 }] : []),
      ...(want('swap') ? [{ outName: 'screenshot-3-swap', raw: rawSwap, title: 'Swap on Solana', subtitle: 'Real time quotes via Jupiter, right inside your wallet.', shotHeight: 640 }] : []),
      ...(!ONLY ? [{ outName: 'screenshot-4-notifications', raw: rawNotifications, title: 'Stay in the loop', subtitle: 'Product announcements arrive right in your wallet.', shotHeight: 640 }] : []),
      ...(!ONLY ? [{ outName: 'screenshot-5-onboarding', raw: rawOnboarding, title: 'Set up in minutes', subtitle: 'Create a new wallet or import your seed phrase. Keys never leave your device.', shotHeight: 500 }] : [])
    ];
    for (const shot of screenshotPlan) {
      const shotOutDir =
        shot.outName === 'screenshot-3-swap' && SWAP_SHOT_OUT_DIR
          ? SWAP_SHOT_OUT_DIR
          : shot.outName === 'screenshot-2-send' && SEND_SHOT_OUT_DIR
            ? SEND_SHOT_OUT_DIR
            : ASSETS_DIR;
      if (shotOutDir !== ASSETS_DIR) mkdirSync(shotOutDir, { recursive: true });
      results.push(
        await compose(cdp, {
          template: 'screenshot-template.html',
          replacements: {
            __TITLE__: shot.title,
            __SUBTITLE__: shot.subtitle,
            __IMG_SRC__: fileUrl(shot.raw),
            __SHOT_HEIGHT__: String(shot.shotHeight)
          },
          width: 1280,
          height: 800,
          outName: shot.outName,
          outDir: shotOutDir
        })
      );
    }
    if (!ONLY) {
      results.push(await compose(cdp, { template: 'promo-tile-template.html', replacements: {}, width: 440, height: 280, outName: 'small-promo-tile-440x280' }));
    }
    if (want('marquee')) {
      if (MARQUEE_CANDIDATES_DIR) {
        // Candidate-compare mode (prompt 0204): renders BOTH tagline
        // candidates OUTSIDE the repo, leaving the real marquee file and
        // template untouched until the owner picks one.
        mkdirSync(MARQUEE_CANDIDATES_DIR, { recursive: true });
        for (const [name, tagline] of Object.entries(MARQUEE_CANDIDATES)) {
          const c = await compose(cdp, {
            template: 'marquee-template.html',
            replacements: { __IMG_SRC__: fileUrl(rawDashboard), [MARQUEE_TEMPLATE_TAGLINE]: tagline },
            width: 1400,
            height: 560,
            outName: `marquee-candidate-${name}`,
            outDir: MARQUEE_CANDIDATES_DIR
          });
          console.log(`[cws-assets] candidate written OUTSIDE the repo: ${path.join(MARQUEE_CANDIDATES_DIR, c.file)}`);
        }
      } else {
        results.push(await compose(cdp, { template: 'marquee-template.html', replacements: { __IMG_SRC__: fileUrl(rawDashboard) }, width: 1400, height: 560, outName: 'marquee-1400x560' }));
      }
    }
  } finally {
    console.log(`[cws-assets] killing browser PID ${proc.pid} (the exact PID this script spawned)`);
    proc.kill();
    await new Promise((resolve) => {
      proc.once('exit', resolve);
      setTimeout(resolve, 5000);
    });
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch (err) {
      console.log(`[cws-assets] temp dir cleanup left behind ${workDir} (${err.message}) — safe to delete by hand.`);
    }
  }

  console.log('\n[cws-assets] all assets written and IHDR verified:');
  for (const r of results) console.log(`  ${path.relative(REPO_ROOT, path.join(r.outDir, r.file)).replace(/\\/g, '/')} — ${r.width}x${r.height}`);
}

main().catch((err) => {
  console.error(`[cws-assets] FAILED: ${err.message}`);
  process.exit(1);
});
