/**
 * Pure logic for the Import-wallet numbered seed grid (prompt 0125,
 * Phantom/MetaMask-style — replacing the old single plain textarea).
 * Deliberately free of any chrome.* / DOM reference, same "extract the
 * decision, keep the side effects in onboarding.js" pattern
 * shared/autoLockDecision.js, shared/cardBackground.js, and
 * shared/resetConfirmation.js already established.
 *
 * This module never validates a mnemonic's own checksum/wordlist
 * membership — that's still exactly what it always was, a
 * FLUXIO_INTERNAL_VALIDATE_MNEMONIC round trip to background.js. Every
 * function here only answers "how should these boxes' text be arranged",
 * nothing about whether the resulting phrase is a REAL recovery phrase.
 */

/** The only two word counts this wallet's mnemonics ever use (see @fluxio/crypto/mnemonic.js's own generateMnemonic). */
export const IMPORT_WORD_COUNTS = Object.freeze([12, 24]);

/**
 * Splits arbitrary pasted text into normalized words: any run of
 * whitespace (space/tab/newline, any quantity — a real pasted phrase
 * might have inconsistent spacing) is a separator, each word is trimmed
 * and lowercased (BIP-39 wordlists are lowercase; a phrase copied from
 * somewhere with Title Case or trailing punctuation-adjacent whitespace
 * should still work), and empty fragments (leading/trailing whitespace
 * producing a stray '') are dropped.
 * @param {unknown} text
 * @returns {string[]}
 */
export function splitPastedWords(text) {
  if (typeof text !== 'string') return [];
  return text
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0);
}

/**
 * Lays `words` into exactly `boxCount` boxes, ALWAYS starting at box 1 —
 * this is the specific Phantom-matching behavior the prompt asked for:
 * pasting into any box (box 5, box 12, doesn't matter) distributes from
 * the beginning, never from the box that happened to receive the paste.
 * Callers are responsible for knowing/passing which box was focused; this
 * function deliberately has no such parameter at all, so there is no way
 * to accidentally wire it to start anywhere else.
 *
 * More words than boxes: the extras are silently dropped (nothing else
 * to do with them — there's nowhere to put a 13th word in a 12-box
 * grid). Fewer words than boxes: the remaining boxes come back as ''
 * (empty), letting isGridComplete() below flag the grid as incomplete —
 * exactly the "distribute apa adanya, biarkan validasi menandai kotak
 * kosong" behavior the prompt specified for a non-12/24 paste.
 * @param {string[]} words
 * @param {number} boxCount
 * @returns {string[]} always exactly `boxCount` long
 */
export function distributeWordsToBoxes(words, boxCount) {
  const result = new Array(boxCount).fill('');
  for (let i = 0; i < boxCount && i < words.length; i++) {
    result[i] = words[i];
  }
  return result;
}

/**
 * Decides whether a paste's word count looks like it was meant for the
 * OTHER standard word count than the grid currently showing — e.g.
 * pasting 24 words while in 12-word mode. Only ever suggests one of the
 * two REAL mnemonic lengths (IMPORT_WORD_COUNTS); a paste of some other
 * count (15 words, a stray sentence, ...) returns null, matching the
 * prompt's own "kalau jumlahnya bukan 12/24, jangan tawarkan apa-apa"
 * requirement.
 * @param {number} pastedWordCount
 * @param {number} currentBoxCount
 * @returns {12 | 24 | null}
 */
export function suggestWordCountForPaste(pastedWordCount, currentBoxCount) {
  if (IMPORT_WORD_COUNTS.includes(pastedWordCount) && pastedWordCount !== currentBoxCount) {
    return pastedWordCount;
  }
  return null;
}

/**
 * Re-lays an existing (possibly partially-typed) grid onto a NEW box
 * count, preserving what still fits: 12->24 keeps all 12 words and pads
 * 12 more empty boxes; 24->12 keeps the first 12 words and drops words
 * 13-24 outright (the caller — onboarding.js — is responsible for
 * confirming that drop with the user FIRST, via wordsWouldBeDiscarded()
 * below, before ever calling this).
 * @param {string[]} currentWords
 * @param {number} newBoxCount
 * @returns {string[]} always exactly `newBoxCount` long
 */
export function remapWordsForBoxCountChange(currentWords, newBoxCount) {
  const kept = currentWords.slice(0, newBoxCount);
  while (kept.length < newBoxCount) kept.push('');
  return kept;
}

/**
 * True if switching to `newBoxCount` would silently throw away a
 * non-empty word the user already typed (only possible going 24->12;
 * 12->24 only ever pads, never truncates, so this always returns false
 * in that direction). Lets the caller decide whether a "this will
 * discard what you typed" confirmation is actually needed, rather than
 * always showing one even when there's nothing to lose.
 * @param {string[]} currentWords
 * @param {number} newBoxCount
 * @returns {boolean}
 */
export function wordsWouldBeDiscarded(currentWords, newBoxCount) {
  return currentWords.slice(newBoxCount).some((w) => typeof w === 'string' && w.trim() !== '');
}

/**
 * The Import button's own enable/disable gate: every box must hold a
 * non-empty word. Says nothing about whether the WORDS are a valid
 * mnemonic — that's still FLUXIO_INTERNAL_VALIDATE_MNEMONIC's job, run
 * only once this is already true.
 * @param {string[]} words
 * @returns {boolean}
 */
export function isGridComplete(words) {
  return words.length > 0 && words.every((w) => typeof w === 'string' && w.trim().length > 0);
}
