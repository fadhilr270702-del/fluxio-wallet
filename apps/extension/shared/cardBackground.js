/**
 * Pure value/default-resolution logic for the "Card background" setting
 * (prompt 0121): the account card on the main wallet-ready screen can
 * show the chevron accent (prompt 0120's own apps/extension/assets/
 * card-accent.png) or a plain black surface with the ornament hidden.
 * Deliberately free of any chrome.* / DOM reference — same "extract the
 * decision, keep the side effects (chrome.storage.local reads/writes)
 * elsewhere" pattern shared/autoLockDecision.js and
 * shared/swapAssetSources.js already established, reusing the test
 * infrastructure those features set up rather than inventing a second
 * one. This module stays this small deliberately — there's exactly one
 * piece of real logic here (resolving a raw storage value to a known-
 * good default), not a whole decision engine, per this feature's own
 * "don't force a module for something trivial" instruction; the storage
 * KEY STRING itself lives in shared/messaging.js instead, matching that
 * file's own established convention.
 */

/** The chevron-accent card (this feature's own specified default). */
export const CARD_BACKGROUND_ACCENT = 'accent';

/** A plain black card — the ornament is hidden, not removed (see popup.js's own renderWalletReady comment for why the <img> tag itself always stays in the DOM). */
export const CARD_BACKGROUND_PLAIN = 'plain';

/**
 * The two selectable options, in display order — the <select> markup in
 * both popup.js's in-popup Settings screen and settings.js's full-tab
 * version builds from this one list, same "one shared list, not two
 * independently-typed copies" precedent as AUTO_LOCK_OPTIONS_MINUTES.
 */
export const CARD_BACKGROUND_OPTIONS = Object.freeze([
  { value: CARD_BACKGROUND_ACCENT, label: 'Accent' },
  { value: CARD_BACKGROUND_PLAIN, label: 'Plain' }
]);

/**
 * Resolves a raw chrome.storage.local value (unset on a fresh install,
 * corrupt/unrecognized data, or a genuine stored choice) to one of the
 * two real values above.
 *
 * Fails toward CARD_BACKGROUND_ACCENT for anything that isn't EXACTLY
 * the literal 'plain' string — this is both this feature's own
 * specified default ("Default: Accent... default Accent bila key belum
 * ada") AND the safer failure direction for corrupt/unexpected data:
 * showing the accent when a user actually chose Plain is a cosmetic
 * annoyance, fixable by reopening Settings and re-picking Plain; the
 * reverse (silently going plain on a typo/corrupt stored value) would
 * look like a missing asset/regression rather than a deliberate choice.
 * Mirrors shouldAutoLock()'s own "fail toward the safer default, not
 * toward trusting unrecognized data" reasoning, just with a different
 * definition of "safer" for a cosmetic setting than for a security one.
 *
 * @param {unknown} raw
 * @returns {'accent' | 'plain'}
 */
export function resolveCardBackground(raw) {
  return raw === CARD_BACKGROUND_PLAIN ? CARD_BACKGROUND_PLAIN : CARD_BACKGROUND_ACCENT;
}
