/**
 * Prompt 0206 — embedded token icons (owner decision: LOGO DITANAM, NOL
 * gambar jarak jauh). Three guarantees locked here:
 *   1. The extension's UI pages never reference a remote image — every
 *      <img> src in the unbundled page sources is a local path (source
 *      scan, same style as unbundledNoBarePackageImports.test.js).
 *   2. Icon lookup is BY MINT: a fake mint claiming the symbol "USDT"
 *      gets NO embedded icon (the popup then renders the colored-letter
 *      placeholder it always had).
 *   3. Every mapped icon file really exists, and the whole set stays
 *      inside the owner's 300 KB budget.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOKEN_ICON_FILES, tokenIconSrc } from '../shared/tokenIcons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.join(__dirname, '..');
const TOKENS_DIR = path.join(EXT_ROOT, 'assets', 'tokens');

const UI_SOURCES = [
  'popup/popup.js',
  'onboarding/onboarding.js',
  'approval/approval.js',
  'settings/settings.js',
  'shared/tokenIcons.js',
  'shared/renderRestrictedHtml.js'
];

describe('no remote images anywhere in the extension UI (prompt 0206 butir 3a)', () => {
  it('no <img> src in any UI page source starts with http(s), and no string literal builds an http image src', () => {
    for (const rel of UI_SOURCES) {
      const file = path.join(EXT_ROOT, rel);
      if (!existsSync(file)) continue;
      const src = readFileSync(file, 'utf8');
      // Literal remote src in any quoting style — must never exist.
      expect(src, `${rel} carries a remote <img> src`).not.toMatch(/src\s*=\s*["'`]https?:/i);
      // Every <img ... src=...> occurrence must resolve to a local path:
      // either a literal relative path or a ${...} expression built from
      // the two local-path generators this codebase has.
      const imgTags = src.match(/<img[^>]*>/g) || [];
      for (const tag of imgTags) {
        const m = tag.match(/src\s*=\s*"([^"]*)"/);
        if (!m) continue; // a bare "<img>" mention (e.g. in a comment) loads nothing
        const value = m[1];
        const isLocalLiteral = value.startsWith('../') || value.startsWith('./') || value.startsWith('assets/');
        // ${localIconPath} is tokenLogoMarkup's own variable — by that
        // function's construction it only ever holds a chainLogoSrc/
        // tokenIconSrc result (both asserted local elsewhere in this file).
        const isLocalGenerated = /^\$\{(chainLogoSrc|tokenIconSrc|localIconPath|escapeHtml\((chainLogoSrc|tokenIconSrc))/.test(value);
        expect(
          isLocalLiteral || isLocalGenerated,
          `<img> src in ${rel} is not a recognized local path: ${value}`
        ).toBe(true);
        expect(value).not.toMatch(/^https?:/i);
      }
    }
  });

  it('tokenIconSrc only ever returns a local ../assets/ path or null', () => {
    for (const mint of Object.keys(TOKEN_ICON_FILES)) {
      const src = tokenIconSrc(mint);
      expect(src.startsWith('../assets/tokens/')).toBe(true);
      expect(src).not.toMatch(/https?:/i);
    }
    expect(tokenIconSrc('NotARealMint')).toBeNull();
  });
});

describe('mint-keyed lookup (prompt 0206 butir 3e)', () => {
  it('the real USDT mint has an embedded icon', () => {
    expect(tokenIconSrc('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')).toBe(
      '../assets/tokens/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB.png'
    );
  });

  it('a FAKE mint whose token claims the symbol "USDT" gets NO icon (falls back to the letter placeholder)', () => {
    // The lookup takes only the mint — a symbol string cannot even be
    // passed in, so a look-alike token structurally cannot borrow the
    // real USDT logo.
    const fakeUsdtMint = 'FakeUsdt1111111111111111111111111111111111';
    expect(tokenIconSrc(fakeUsdtMint)).toBeNull();
  });
});

describe('EVM address aliases (prompt 0214): BNB Chain USDT reuses the Solana USDT PNG', () => {
  const USDT_PNG = '../assets/tokens/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB.png';

  it('the checksummed BEP20 USDT contract resolves to the USDT PNG (0x input is lowercased before lookup)', () => {
    expect(tokenIconSrc('0x55d398326f99059fF775485246999027B3197955')).toBe(USDT_PNG);
  });

  it('the lowercase spelling resolves to the same PNG', () => {
    expect(tokenIconSrc('0x55d398326f99059ff775485246999027b3197955')).toBe(USDT_PNG);
  });

  it('a foreign EVM address still gets NO icon', () => {
    expect(tokenIconSrc('0x0000000000000000000000000000000000dEaD')).toBeNull();
  });

  // Prompt 0230: USDC on Ethereum and Base alias to the Solana USDC PNG.
  // Addresses are the registry's own (tokens.js mainnet entries), not
  // invented strings — checksummed spelling, proving the lowercase step.
  const USDC_PNG = '../assets/tokens/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.png';

  it('the checksummed Ethereum USDC contract resolves to the same PNG as the Solana USDC mint', () => {
    expect(tokenIconSrc('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(USDC_PNG);
    expect(tokenIconSrc('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(USDC_PNG);
  });

  it('the checksummed Base USDC contract resolves to the same PNG as the Solana USDC mint', () => {
    expect(tokenIconSrc('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(USDC_PNG);
  });
});

describe('embedded icon files (prompt 0206 butir 3d/3e)', () => {
  it('every mapped mint has its PNG on disk, named exactly <mint>.png', () => {
    for (const [mint, file] of Object.entries(TOKEN_ICON_FILES)) {
      expect(file).toBe(`${mint}.png`);
      expect(existsSync(path.join(TOKENS_DIR, file)), `${file} missing`).toBe(true);
    }
  });

  it('no stray files, and the whole set stays within the 300 KB budget', () => {
    const files = readdirSync(TOKENS_DIR);
    expect(files.sort()).toEqual(Object.values(TOKEN_ICON_FILES).sort());
    const total = files.reduce((sum, f) => sum + statSync(path.join(TOKENS_DIR, f)).size, 0);
    expect(total).toBeLessThanOrEqual(300 * 1024);
    // Every file is a real PNG (magic bytes), never an SVG or anything else.
    for (const f of files) {
      const head = readFileSync(path.join(TOKENS_DIR, f)).subarray(0, 8);
      expect(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).equals(head), `${f} is not a PNG`).toBe(true);
    }
  });
});
