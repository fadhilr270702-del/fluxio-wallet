/**
 * Pure decision logic for the two-step "Add custom token" form (prompt
 * 0119 — replacing the old flat symbol/name/decimals form that manual
 * verification of prompts 0108/0109 found genuinely confusing, see
 * prompt/0119-add-token-ux-two-step.md). Deliberately small: most of this
 * form is DOM/markup/wiring work that stays inline in popup.js like every
 * other screen there (no separate pure module for "which HTML string to
 * render" — that's not a decision worth extracting). The one piece that
 * IS extracted is the single rule this feature is most at risk of getting
 * wrong: whether the decimals field should ever be user-editable.
 *
 * THE RULE THIS FILE PROTECTS: a Solana token's decimals must NEVER be
 * user-editable — it's always read from the mint account itself,
 * on-chain, authoritative (see FLUXIO_INTERNAL_ADD_CUSTOM_TOKEN's own
 * comment in background.js: "an ERRONEOUS decimals value directly
 * corrupts every displayed balance for that token"). An EVM token's
 * decimals is editable ONLY when on-chain metadata resolution genuinely
 * couldn't determine it (e.g. the local RPC — anvil — is down, a real,
 * routine occurrence this feature must not lock users out during). This
 * asymmetry is exactly the kind of chain-specific rule that's easy to
 * get backwards while wiring up a form's conditional rendering, so it's
 * pulled out here where it can be unit-tested directly — mirroring
 * shared/autoLockDecision.js/swapAssetSources.js's own "extract the one
 * real decision, leave DOM work where it is" pattern.
 *
 * The actual SECURITY boundary for this rule is NOT this file — it's
 * background.js's FLUXIO_INTERNAL_ADD_CUSTOM_TOKEN handler, which
 * rejects a manually-supplied `decimals` for a Solana network outright,
 * server-side, regardless of what the popup's own UI happens to render
 * (never loosened by this feature — see this feature's own scope note).
 * This file only decides what the UI SHOWS; it cannot itself let a bad
 * value through.
 */

/** Every state the Add Token form's "step" can be in — exported so popup.js's own render function switches on the SAME literal set this file's own logic reasons about, not a second hand-typed list that could drift. */
export const LOOKUP_STATUS = Object.freeze({
  ADDRESS: 'address', // step 1 — no lookup attempted yet, or the address changed since the last one
  LOOKING_UP: 'looking-up', // a preview fetch is in flight
  FOUND: 'found', // on-chain metadata resolved (fully or partially) — step 2 preview
  RPC_UNREACHABLE: 'rpc-unreachable', // every RPC endpoint failed — offer Retry, and (EVM only) a manual fallback
  NOT_FOUND: 'not-found', // the RPC answered: genuinely no contract/mint at this address — reject, don't offer to save
  MANUAL: 'manual' // EVM-only: user chose "enter details manually" after an rpc-unreachable outcome — step 2 preview with nothing pre-filled
});

/**
 * Decides whether the decimals FIELD should be editable in the step-2
 * preview, given the chain and what on-chain resolution returned (or
 * didn't).
 * @param {object} params
 * @param {boolean} params.isEvm
 * @param {number|null|undefined} params.fetchedDecimals - the decimals value metadata resolution returned, or null/undefined if it couldn't be determined at all.
 * @returns {boolean}
 */
export function isDecimalsEditable({ isEvm, fetchedDecimals }) {
  if (!isEvm) return false; // Solana: NEVER editable, no exceptions — see this file's own header comment.
  return fetchedDecimals == null;
}

/**
 * Decides whether an RPC-unreachable outcome should offer a "enter
 * details manually" fallback. Solana can never offer this: without a
 * real mint read, decimals is fundamentally unknowable, and this repo
 * never lets a Solana token's decimals be guessed or typed in — so
 * there is nothing useful "manual entry" could mean for a Solana token
 * whose RPC is down; the only sensible action is Retry.
 * @param {object} params
 * @param {boolean} params.isEvm
 * @returns {boolean}
 */
export function canOfferManualFallback({ isEvm }) {
  return isEvm;
}
