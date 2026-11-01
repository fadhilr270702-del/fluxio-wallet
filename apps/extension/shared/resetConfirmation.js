/**
 * Pure gate logic for the "type RESET to confirm" destructive-reset
 * screen (prompt 0124 — "Forgot password?"). Deliberately free of any
 * chrome.* / DOM reference, same "extract the decision, keep the side
 * effects elsewhere" pattern shared/autoLockDecision.js and
 * shared/cardBackground.js already established — popup.js only ever
 * calls isResetConfirmationValid() to decide whether the destructive
 * button should be enabled; it never re-implements the comparison
 * itself.
 *
 * Fails SAFE by construction: anything other than an exact match keeps
 * the caller's button disabled, including the empty string, so there is
 * no code path where the button starts (or silently becomes) enabled
 * without the user having typed the phrase exactly.
 */

/** The exact phrase the user must type — case-sensitive, no trimming. */
export const RESET_CONFIRMATION_PHRASE = 'RESET';

/**
 * @param {unknown} input - the live value of the confirmation text input.
 * @returns {boolean} true only for the exact string 'RESET' — anything
 *   else (wrong case, extra/missing whitespace, a prefix/suffix, a
 *   non-string value, empty/undefined/null) returns false.
 */
export function isResetConfirmationValid(input) {
  return input === RESET_CONFIRMATION_PHRASE;
}
