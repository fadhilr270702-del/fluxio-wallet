/**
 * Automated regression guard for the real-Chrome bug found in manual
 * verification of prompt 0118 (see prompt/0118-fiat-portfolio-value.md's
 * own Revision 1): `apps/extension/shared/portfolioValue.js` imported
 * `@fluxio/constants` directly, and popup.js/settings.js importing an
 * unrelated plain constant from that same file was enough to drag that
 * bare import in transitively — crashing the popup outright in real
 * Chrome (`Uncaught TypeError: Failed to resolve module specifier
 * "@fluxio/constants"`), completely invisible to every other layer of
 * verification this repo already had:
 *   - `pnpm test` (Vitest/Node) resolves `@fluxio/constants` via the
 *     pnpm workspace like any other tool would — it has no concept of
 *     "this file will actually be loaded directly by a browser with no
 *     bundler", so it saw nothing wrong.
 *   - The e2e bundle tests (test/backgroundAutoLockBundle.e2e.test.js,
 *     test/backgroundPortfolioBundle.e2e.test.js) only ever load
 *     background.bundle.js — a completely different artifact built by a
 *     real bundler (esbuild) that DOES resolve `@fluxio/*` correctly.
 *     They never touch popup.js's own module graph at all.
 *   - `pnpm build:extension` (build.mjs) only ever bundles
 *     background/background.js (see that script's own entryPoints) — it
 *     never even looks at popup.js/settings.js/onboarding.js/approval.js,
 *     by design (this repo's whole "most of the extension stays
 *     unbundled" architecture, see CLAUDE.md).
 *   - Code review caught the SAME rule being followed correctly
 *     elsewhere (every unbundled page's own header comment states "never
 *     imports @fluxio/crypto or @fluxio/services directly") but missed
 *     applying it to a brand-new shared/ module, because "shared/" had
 *     — by pure coincidence, never as an enforced rule — always
 *     contained only bare-import-free files (autoLockDecision.js,
 *     swapAssetSources.js, messaging.js, revealSeed.js) until this one.
 *
 * This test is the missing layer: it doesn't check a directory
 * convention (some shared/ files, like portfolioValue.js, are correctly
 * @fluxio/*-dependent and background.js-only — see that file's own
 * header comment) — it TRACES THE REAL IMPORT GRAPH starting from every
 * file a real browser actually loads directly as an ES module (each
 * unbundled page's own `<script type="module">` entry, per its .html
 * file, plus content-script/inject.js and provider/provider.js per
 * manifest.json/inject.js's own dynamic script injection) and asserts
 * every specifier reachable from there is relative. This is exactly the
 * semantic a browser's own module resolver applies — background.js
 * (the one bundled entry point) is deliberately never a starting point
 * here, and any file only ever reachable THROUGH background.js (like
 * portfolioValue.js) is correctly never visited, never flagged.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.join(__dirname, '..');

/**
 * Every file a real browser loads directly as an ES module without going
 * through esbuild — one entry per unbundled page's own `<script
 * type="module">` tag (popup.html/onboarding.html/settings.html/
 * approval.html) plus content-script/inject.js (the classic-script
 * content script itself — verified to contain zero imports, kept in this
 * list as a standing guard in case that ever changes) and
 * provider/provider.js (dynamically injected by inject.js with
 * `script.type = 'module'` — confirmed by reading inject.js directly, not
 * assumed). background/background.js is deliberately EXCLUDED — it's the
 * one file this extension bundles via esbuild (see build.mjs), and
 * legitimately needs `@fluxio/*` bare imports to do its job.
 */
const ENTRY_POINTS = [
  'popup/popup.js',
  'onboarding/onboarding.js',
  'settings/settings.js',
  'approval/approval.js',
  'content-script/inject.js',
  'provider/provider.js'
];

/**
 * Matches the import specifier string in every ES module import/export
 * form this codebase could plausibly use: `import ... from '<spec>'`,
 * `import '<spec>'` (side-effect only), `export ... from '<spec>'`,
 * `export * from '<spec>'`, and a dynamic `import('<spec>')` call.
 */
const IMPORT_SPECIFIER_RE =
  /\b(?:import|export)\b[^;'"()]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;

function extractSpecifiers(source) {
  const specifiers = [];
  const re = new RegExp(IMPORT_SPECIFIER_RE);
  let match;
  while ((match = re.exec(source))) {
    const spec = match[1] || match[2] || match[3];
    if (spec) specifiers.push(spec);
  }
  return specifiers;
}

/** A relative specifier is safe (any browser/bundler resolves it identically) — anything else ("@fluxio/constants", "buffer", a bare npm package name, ...) needs a real bundler, which no unbundled page ever gets. */
function isRelativeSpecifier(spec) {
  return spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/');
}

function resolveRelative(fromAbsPath, spec) {
  let resolved = path.join(path.dirname(fromAbsPath), spec);
  if (!existsSync(resolved) && existsSync(`${resolved}.js`)) {
    resolved = `${resolved}.js`;
  }
  return resolved;
}

function toRepoRelative(absPath) {
  return path.relative(EXT_ROOT, absPath).replace(/\\/g, '/');
}

/** Recursively walks the real import graph from `entryRelPath`, collecting every visited file and every bare-specifier violation found anywhere in that graph. */
function walkImportGraph(entryRelPath, visited = new Set(), violations = []) {
  const absPath = path.join(EXT_ROOT, entryRelPath);
  const relKey = toRepoRelative(absPath);
  if (visited.has(relKey)) return { visited, violations };
  visited.add(relKey);

  if (!existsSync(absPath)) {
    violations.push(`${relKey}: file does not exist (broken import chain — check the import that led here)`);
    return { visited, violations };
  }

  const source = readFileSync(absPath, 'utf8');
  for (const spec of extractSpecifiers(source)) {
    if (!isRelativeSpecifier(spec)) {
      violations.push(
        `${relKey}: bare-specifier import "${spec}" — this file is reachable from an unbundled <script type="module"> entry point, so a real browser can NEVER resolve this (only esbuild-bundled background.js can)`
      );
      continue;
    }
    walkImportGraph(toRepoRelative(resolveRelative(absPath, spec)), visited, violations);
  }
  return { visited, violations };
}

describe('unbundled pages — no bare-specifier imports anywhere in their real import graph (regression guard for prompt 0118 Revision 1)', () => {
  it.each(ENTRY_POINTS)('%s and everything it transitively imports uses only relative imports', (entry) => {
    const { violations } = walkImportGraph(entry);
    expect(violations).toEqual([]);
  });

  it('sanity check: the walker actually traverses into shared/ (not silently visiting nothing) and correctly never reaches the background-only sibling module', () => {
    const allVisited = new Set();
    for (const entry of ENTRY_POINTS) {
      walkImportGraph(entry, allVisited);
    }
    const visitedList = [...allVisited];
    expect(visitedList).toContain('shared/messaging.js');
    expect(visitedList).toContain('shared/autoLockDecision.js');
    expect(visitedList).toContain('shared/swapAssetSources.js');
    expect(visitedList).toContain('shared/portfolioDisplay.js');
    // portfolioValue.js is legitimately @fluxio/constants-dependent and
    // background.js-only (see its own header comment) — it must NEVER
    // be reachable from an unbundled entry point. This is the exact
    // invariant the whole file exists to protect; asserted directly.
    expect(visitedList).not.toContain('shared/portfolioValue.js');
  });
});
