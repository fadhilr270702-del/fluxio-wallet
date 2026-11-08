// 0223 Revisi 2 — the Confirm CLICK PATH itself, against the REAL
// popup.js module (imported with the guarded test seam, driven through a
// minimal hand-rolled document/chrome stub — no DOM library, no new
// dependency). Born from a real dead-button incident: the tahap B belt
// `if (isEvmTokenIn) return;` survived into tahap C and swallowed every
// token-in Confirm click silently; the fase 2 e2e suite drove the
// BACKGROUND message handlers directly and the text test only grepped the
// source, so neither could see that the button never SENT anything.
// Lesson (0223 archive): a UI text test does not prove the button works.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POPUP_PATH = path.join(__dirname, '..', 'popup', 'popup.js');
const CLICK_TEST_TIMEOUT_MS = 30000; // prompt 0194's measured pattern: the big popup module import crawls under full-suite worker contention
const USDT_BEP20 = '0x55d398326f99059fF775485246999027B3197955';

const elements = new Map();
function makeElement(id) {
  // textContent/innerHTML emulate the one DOM behavior the popup's own
  // escapeHtml() depends on (set textContent, read back innerHTML with
  // the entities escaped) — without it every escaped string renders ''
  // and the harness can't see any template text (found the hard way in
  // the 0223 Revisi 3 tambahan run).
  const stub = {
    id,
    _innerHTML: '',
    _textContent: '',
    hidden: false,
    disabled: false,
    value: '',
    style: {},
    dataset: {},
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
    click() {
      for (const fn of this.listeners.click || []) fn({ preventDefault() {} });
    },
    appendChild() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    focus() {},
    setAttribute() {},
    removeAttribute() {}
  };
  Object.defineProperty(stub, 'textContent', {
    get() {
      return this._textContent;
    },
    set(value) {
      this._textContent = String(value ?? '');
      this._innerHTML = this._textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  });
  Object.defineProperty(stub, 'innerHTML', {
    get() {
      return this._innerHTML;
    },
    set(value) {
      this._innerHTML = String(value ?? '');
    }
  });
  return stub;
}
function el(id) {
  if (!elements.has(id)) elements.set(id, makeElement(id));
  return elements.get(id);
}

let sentMessages = [];
let executeResponseOverride = null;
let previewResponseOverride = null;
// 0241 Opsi A harness extensions: hold a PREVIEW response in flight (the
// race the 22 Oktober incident rode), release it later, or fail it — all
// through the same stubbed sendMessage, no new mechanism.
let holdPreviews = false;
let heldPreviewResponders = [];
let previewErrorOverride = null;
function releaseHeldPreviews() {
  const held = heldPreviewResponders;
  heldPreviewResponders = [];
  for (const respondNow of held) respondNow();
}
function installStubs() {
  elements.clear();
  // A FRESH array per install: a timed-out test body keeps running in the
  // background (vitest never kills it) and must spill its late messages
  // into ITS OWN capture, never the next test's (seen live in the first
  // full-suite run of this file).
  const captured = [];
  sentMessages = captured;
  executeResponseOverride = null;
  previewResponseOverride = null;
  holdPreviews = false;
  heldPreviewResponders = [];
  previewErrorOverride = null;
  globalThis.document = {
    getElementById: (id) => el(id),
    addEventListener() {},
    removeEventListener() {},
    createElement: (tag) => makeElement(`created-${tag}`),
    createTextNode: (text) => ({ textContent: text }),
    body: makeElement('body')
  };
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, cb) {
        captured.push(message);
        const respond = (response) => cb && cb({ response });
        switch (message.type) {
          case 'FLUXIO_INTERNAL_GET_ACTIVE_SWAP':
            return respond({ active: false });
          case 'FLUXIO_INTERNAL_GET_STATUS':
            return respond({ hasWallet: false });
          case 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES': {
            const previewReply = () => {
              if (previewErrorOverride) return cb && cb({ error: previewErrorOverride });
              if (previewResponseOverride) return respond(previewResponseOverride);
              // The real token-in preview shape (tahap C): TWO ceilings, one
              // combined total, approve needed (allowance 0 on chain today).
              return respond({
                kind: 'evm',
                tokenIn: true,
                approveNeeded: true,
                nativeSymbol: 'BNB',
                approveMaxFeeWei: '2880000000000',
                swapMaxFeeWei: '20162300000000',
                maxFeeWei: '23042300000000',
                maxFeeFormatted: '0.0000230423'
              });
            };
            if (holdPreviews) {
              heldPreviewResponders.push(previewReply);
              return;
            }
            return previewReply();
          }
          case 'FLUXIO_INTERNAL_SEND_TRANSFER':
            // 0242: hentikan alur di sini — tes hanya memeriksa payload pesan.
            return cb && cb({ error: 'STUB_STOP' });
          case 'FLUXIO_INTERNAL_EXECUTE_SWAP':
            if (executeResponseOverride) return respond(executeResponseOverride);
            return respond({
              stage: 'approve',
              twoStep: true,
              approveHash: '0x' + 'aa'.repeat(32),
              signature: '0x' + 'aa'.repeat(32),
              hash: '0x' + 'aa'.repeat(32),
              explorerUrl: 'https://bscscan.com/tx/0x' + 'aa'.repeat(32)
            });
          default:
            return respond({});
        }
      }
    },
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} }
    },
    tabs: { create: () => {} }
  };
  globalThis.__FLUXIO_POPUP_TEST_HOOKS__ = true;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function importPopup() {
  await import(`${pathToFileURL(POPUP_PATH).href}?bust=${Math.random()}`);
  const hooks = globalThis.__FLUXIO_POPUP_HOOKS__;
  expect(hooks).toBeTruthy();
  return hooks;
}

/** The Review `details` a token-in quote really produces (fixture 7c figures). */
function tokenInDetails() {
  return {
    networkKey: 'bnb',
    payAsset: { type: 'token', address: USDT_BEP20, symbol: 'USDT', decimals: 18, balance: '1.318780516355845246' },
    receiveAsset: { type: 'native', address: 'native', symbol: 'BNB', decimals: 18, balance: '0.00113911325' },
    amount: '0.5',
    slippageBps: 50,
    quotedAt: Date.now(),
    quote: {
      quoteId: 'q-test-0223',
      inAmountFormatted: '0.5',
      outAmountFormatted: '0.00069261626737937',
      minReceivedFormatted: '0.000689153186042473',
      priceImpactPct: '0.001',
      slippageBps: 50,
      feeIncluded: true,
      feeBps: 85,
      feeSide: 'input',
      feeAmountFormatted: '0.00425'
    }
  };
}

describe('popup.js — the Confirm click path for token-in (0223 Revisi 2)', () => {
  beforeEach(() => {
    installStubs();
  }, CLICK_TEST_TIMEOUT_MS);

  it('clicking Confirm on a USDT to BNB Review genuinely SENDS EXECUTE_SWAP with the same quoteId (the dead-button incident can never return silently again)', async () => {
    const hooks = await importPopup();
    hooks.renderSwapReview({}, tokenInDetails());
    await flush(); // the PREVIEW round trip fills the fee row + two-tx note
    expect(el('twoTxNote').hidden).toBe(false); // approveNeeded -> the K5 sentence shows
    el('confirmSwapBtn').click();
    await flush();
    const executes = sentMessages.filter((m) => m.type === 'FLUXIO_INTERNAL_EXECUTE_SWAP');
    expect(executes.length).toBe(1);
    expect(executes[0].quoteId).toBe('q-test-0223');
    expect(executes[0].networkKey).toBe('bnb');
  }, CLICK_TEST_TIMEOUT_MS);

  it('(0231 Revisi 2, INVESTIGASI 3) dua Review berturut dengan quote berbeda: Confirm mengirim quoteId yang TERAKHIR dirender — id yang tampil = id yang dieksekusi', async () => {
    const hooks = await importPopup();
    const a = tokenInDetails();
    a.quote = { ...a.quote, quoteId: 'q-first' };
    hooks.renderSwapReview({}, a);
    await flush(); // PREVIEW pertama (id pertama)
    const b = tokenInDetails();
    b.quote = { ...b.quote, quoteId: 'q-second' };
    // DOM nyata mengganti tombol lewat innerHTML saat re-render — stub
    // harness mempertahankan listener lama, jadi ditiru dengan menghapus
    // listener render pertama (artefak alat, bukan perilaku produk).
    el('confirmSwapBtn').listeners = {};
    hooks.renderSwapReview({}, b); // re-render (mis. quote diperbarui)
    await flush(); // PREVIEW kedua (id kedua)
    const previews = sentMessages.filter((m) => m.type === 'FLUXIO_INTERNAL_PREVIEW_SWAP_FEES').map((m) => m.quoteId);
    expect(previews).toEqual(['q-first', 'q-second']); // setiap render preview id-nya sendiri
    el('confirmSwapBtn').click();
    await flush();
    const executes = sentMessages.filter((m) => m.type === 'FLUXIO_INTERNAL_EXECUTE_SWAP');
    expect(executes.length).toBe(1);
    expect(executes[0].quoteId).toBe('q-second'); // id TAMPIL terakhir = id DIEKSEKUSI
  }, CLICK_TEST_TIMEOUT_MS);

  it('token to token stays blocked but NEVER silently: no EXECUTE_SWAP goes out and the note says so', async () => {
    const hooks = await importPopup();
    const details = tokenInDetails();
    details.receiveAsset = { type: 'token', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18, balance: '0' };
    hooks.renderSwapReview({}, details);
    await flush();
    el('confirmSwapBtn').click();
    await flush();
    expect(sentMessages.some((m) => m.type === 'FLUXIO_INTERNAL_EXECUTE_SWAP')).toBe(false);
    expect(el('swapReviewNote').textContent).toBe('Swapping a token to another token is coming soon.');
  }, CLICK_TEST_TIMEOUT_MS);

  it('pay picker native row logo follows the ACTIVE network: chains/bnb.png on BNB Chain, chains/solana.png on Solana (the 0223 Revisi 2 icon fix)', async () => {
    const hooks = await importPopup();
    const payAssets = [
      { type: 'native', address: 'native', symbol: 'BNB', decimals: 18, balance: '0.001' },
      { type: 'token', address: USDT_BEP20, symbol: 'USDT', decimals: 18, balance: '1.3' }
    ];
    hooks.renderSwapPayPicker({}, payAssets, { networkKey: 'bnb', payAsset: payAssets[0] }, () => {});
    const bnbHtml = el('app').innerHTML;
    expect(bnbHtml.includes('chains/bnb.png')).toBe(true);
    expect(bnbHtml.includes('chains/solana.png')).toBe(false);

    const solAssets = [{ type: 'native', address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9, balance: '0.03' }];
    hooks.renderSwapPayPicker({}, solAssets, { networkKey: 'solana', payAsset: solAssets[0] }, () => {});
    expect(el('app').innerHTML.includes('chains/solana.png')).toBe(true);
  }, CLICK_TEST_TIMEOUT_MS);

  it('g2 fee code (0223 Revisi 3 tambahan): EXECUTE answering EVM_SWAP_FEE_ABOVE_DISPLAYED re-renders Review with the FEE sentence, not the quote-updated one', async () => {
    const hooks = await importPopup();
    const details = tokenInDetails();
    executeResponseOverride = {
      quoteChanged: true,
      code: 'EVM_SWAP_FEE_ABOVE_DISPLAYED',
      quote: { ...details.quote, quoteId: 'q-test-0223-b' }
    };
    hooks.renderSwapReview({}, details);
    await flush();
    el('confirmSwapBtn').click();
    await flush();
    const html = el('app').innerHTML;
    expect(html.includes('Network fee is now higher than shown. Review the new fee.')).toBe(true);
    expect(html.includes('Quote updated. Review the new amounts.')).toBe(false);
    expect(/[-–—]/.test('Network fee is now higher than shown. Review the new fee.')).toBe(false);
  }, CLICK_TEST_TIMEOUT_MS);
});

// 0227 (0225 K1/K8): Ethereum through the SAME click path, and the three
// transaction note when the preview says a reset leg leads.
describe('popup.js — Confirm click on Ethereum + the reset note (0227)', () => {
  beforeEach(() => {
    installStubs();
  }, CLICK_TEST_TIMEOUT_MS);

  it('clicking Confirm on an ETH to USDC Review sends EXECUTE_SWAP with networkKey ethereum (lesson 11: the click itself is tested)', async () => {
    const hooks = await importPopup();
    const details = tokenInDetails();
    details.networkKey = 'ethereum';
    details.payAsset = { type: 'native', address: 'native', symbol: 'ETH', decimals: 18, balance: '0.008845262366463' };
    details.receiveAsset = { type: 'token', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6, balance: '0' };
    previewResponseOverride = { kind: 'evm', nativeSymbol: 'ETH', gasLimit: '547532', maxFeePerGas: '263210768', maxFeeWei: '144116526550000', maxFeeFormatted: '0.00014411652655' };
    hooks.renderSwapReview({}, details);
    await flush();
    el('confirmSwapBtn').click();
    await flush();
    const executes = sentMessages.filter((m) => m.type === 'FLUXIO_INTERNAL_EXECUTE_SWAP');
    expect(executes.length).toBe(1);
    expect(executes[0].networkKey).toBe('ethereum');
  }, CLICK_TEST_TIMEOUT_MS);

  it('a preview with approveResetNeeded swaps the Review note to the three transaction sentence (0225 K8)', async () => {
    const hooks = await importPopup();
    previewResponseOverride = {
      kind: 'evm', tokenIn: true, approveNeeded: true, approveResetNeeded: true, nativeSymbol: 'BNB',
      resetMaxFeeWei: '1440000000000', approveMaxFeeWei: '2880000000000', swapMaxFeeWei: '20162300000000',
      maxFeeWei: '24482300000000', maxFeeFormatted: '0.0000244823'
    };
    const hooksDetails = tokenInDetails();
    hooks.renderSwapReview({}, hooksDetails);
    await flush();
    expect(el('twoTxNote').hidden).toBe(false);
    expect(el('twoTxNote').textContent).toBe('This swap sends three transactions: a reset, an approval and the swap.');
  }, CLICK_TEST_TIMEOUT_MS);
});

// 0241 Opsi A — akar insiden 22 Oktober (catatan 22): Confirm tidak boleh
// berangkat sebelum PREVIEW render ini menulis plafon ke entry, dan respons
// preview dari render LAMA tidak boleh menimpa angka render baru. Ketiga
// tes ini GAGAL pada kode pra-0241 (dibuktikan di arsip 0241) dan LULUS
// sesudahnya.
describe('popup.js — gating preview + penanda render (0241 Opsi A)', () => {
  beforeEach(() => {
    installStubs();
  }, CLICK_TEST_TIMEOUT_MS);

  it('(0241-1) klik Confirm saat PREVIEW masih in flight: TIDAK ada EXECUTE_SWAP, tombol tertahan "Estimating network fee…"', async () => {
    const hooks = await importPopup();
    holdPreviews = true;
    hooks.renderSwapReview({}, tokenInDetails());
    await flush(); // PREVIEW terkirim tapi DITAHAN — belum ada plafon di entry
    expect(el('confirmSwapBtn').disabled).toBe(true);
    expect(el('confirmSwapBtn').textContent).toBe('Estimating network fee…');
    el('confirmSwapBtn').click(); // stub click mengabaikan disabled — persis kenapa handler butuh pagar sendiri
    await flush();
    expect(sentMessages.some((m) => m.type === 'FLUXIO_INTERNAL_EXECUTE_SWAP')).toBe(false);
    // 0223 Revisi 2 rule: tidak ada jalur keluar diam — teks tampil.
    expect(el('swapReviewNote').textContent).toBe('Estimating network fee…');
    // Pelepasan preview SETELAH klik: tombol baru aktif sekarang.
    releaseHeldPreviews();
    await flush();
    expect(el('confirmSwapBtn').disabled).toBe(false);
    expect(el('confirmSwapBtn').textContent).toBe('Confirm Swap');
  }, CLICK_TEST_TIMEOUT_MS);

  it('(0241-2) PREVIEW gagal: fee "unavailable", klik Confirm TIDAK mengirim EXECUTE_SWAP, pesan "Fee estimate failed. Go back and try again."', async () => {
    const hooks = await importPopup();
    previewErrorOverride = 'RPC_DOWN: endpoint refused';
    hooks.renderSwapReview({}, tokenInDetails());
    await flush();
    expect(el('evmSwapFeeValue').textContent).toBe('unavailable');
    expect(el('confirmSwapBtn').disabled).toBe(true);
    el('confirmSwapBtn').click();
    await flush();
    expect(sentMessages.some((m) => m.type === 'FLUXIO_INTERNAL_EXECUTE_SWAP')).toBe(false);
    expect(el('swapReviewNote').textContent).toBe('Fee estimate failed. Go back and try again.');
  }, CLICK_TEST_TIMEOUT_MS);

  it('(0241-3) respons PREVIEW render LAMA tiba setelah render baru: angka render baru TIDAK tertimpa (penanda render)', async () => {
    const hooks = await importPopup();
    const a = tokenInDetails();
    a.quote = { ...a.quote, quoteId: 'q-old' };
    holdPreviews = true;
    hooks.renderSwapReview({}, a);
    await flush(); // preview quote lama DITAHAN in flight
    // DOM nyata mengganti tombol lewat innerHTML saat re-render — artefak
    // stub yang sama seperti tes INVESTIGASI 3: listener render lama dihapus.
    el('confirmSwapBtn').listeners = {};
    holdPreviews = false;
    previewResponseOverride = {
      kind: 'evm', tokenIn: true, approveNeeded: true, nativeSymbol: 'BNB',
      approveMaxFeeWei: '2880000000000', swapMaxFeeWei: '20162300000000',
      maxFeeWei: '23042300000000', maxFeeFormatted: '0.0000230423'
    };
    const b = tokenInDetails();
    b.quote = { ...b.quote, quoteId: 'q-new' };
    hooks.renderSwapReview({}, b);
    await flush(); // preview render BARU selesai — angka benar tampil
    expect(el('evmSwapFeeValue').textContent).toBe('0.0000230423 BNB');
    // Baru sekarang respons lama tiba (angka SALAH untuk quote yang tampil).
    previewResponseOverride = {
      kind: 'evm', tokenIn: true, approveNeeded: true, nativeSymbol: 'BNB',
      approveMaxFeeWei: '2880000000000', swapMaxFeeWei: '53196215931954',
      maxFeeWei: '56076215931954', maxFeeFormatted: '0.000056076215931954'
    };
    releaseHeldPreviews();
    await flush();
    expect(el('evmSwapFeeValue').textContent).toBe('0.0000230423 BNB'); // tetap angka render baru
    expect(el('confirmSwapBtn').disabled).toBe(false); // gating render baru tidak terganggu
  }, CLICK_TEST_TIMEOUT_MS);

});

// 0242 — catatan 23 (kosmetik: keterangan batas atas pada token masuk saja)
// dan catatan 18 (lesson 11: popup benar benar MENGIRIM plafon tampil di
// SEND_TRANSFER — tanpa ini pagar background tidak pernah menerima angka).
describe('popup.js — keterangan plafon token masuk (0242 catatan 23) + plafon Send ikut SEND_TRANSFER (0242 catatan 18)', () => {
  beforeEach(() => {
    installStubs();
  }, CLICK_TEST_TIMEOUT_MS);

  const UPPER_LIMIT_NOTE = 'This is an upper limit. The actual fee is usually much lower.';

  it('(23) Review token masuk menampilkan keterangan batas atas di bawah Max network fee', async () => {
    const hooks = await importPopup();
    hooks.renderSwapReview({}, tokenInDetails());
    await flush();
    expect(el('app').innerHTML.includes(UPPER_LIMIT_NOTE)).toBe(true);
  }, CLICK_TEST_TIMEOUT_MS);

  it('(23) Review native masuk TIDAK menampilkan keterangan itu', async () => {
    const hooks = await importPopup();
    const details = tokenInDetails();
    details.networkKey = 'ethereum';
    details.payAsset = { type: 'native', address: 'native', symbol: 'ETH', decimals: 18, balance: '0.008' };
    details.receiveAsset = { type: 'token', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6, balance: '0' };
    previewResponseOverride = { kind: 'evm', nativeSymbol: 'ETH', maxFeeWei: '144116526550000', maxFeeFormatted: '0.00014411652655' };
    hooks.renderSwapReview({}, details);
    await flush();
    expect(el('app').innerHTML.includes(UPPER_LIMIT_NOTE)).toBe(false);
  }, CLICK_TEST_TIMEOUT_MS);

  it('(18) klik Confirm & Send mengirim SEND_TRANSFER dengan displayedMaxFeeWei = maxFeeWei estimasi yang tampil', async () => {
    const hooks = await importPopup();
    expect(typeof hooks.renderSendConfirm).toBe('function'); // hook baru 0242
    hooks.renderSendConfirm('ethereum', {}, { type: 'native', address: 'native', symbol: 'ETH', decimals: 18 }, {
      to: '0x4B2c00fD7647780F1d21694Ce51feA235De7Ca39',
      amount: '0.0005',
      symbol: 'ETH',
      isToken: false,
      feeAmount: '0.000269237905716168',
      isMaxFee: true,
      totalAmount: '0.000769237905716168',
      maxFeeWei: '269237905716168'
    });
    el('confirmBtn').click();
    await flush();
    const sends = sentMessages.filter((m) => m.type === 'FLUXIO_INTERNAL_SEND_TRANSFER');
    expect(sends.length).toBe(1);
    expect(sends[0].displayedMaxFeeWei).toBe('269237905716168');
    expect(sends[0].networkKey).toBe('ethereum');
  }, CLICK_TEST_TIMEOUT_MS);
});
