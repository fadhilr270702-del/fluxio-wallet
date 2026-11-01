/**
 * Prompt 0153 — the contextual warning shown in Compose/Welcome. Pure and
 * unit-tested on its own, kept separate from the pages that render it so
 * the condition itself — not just the wording — has direct test coverage.
 *
 * Prompt 0156 — the user's own live verification on the trial bot proved
 * an inline button's premium icon (`icon_custom_emoji_id`) degrades in the
 * real Telegram client exactly like a text-level `<tg-emoji>` does (a plain
 * button, no icon), even though the API response still echoes the field
 * back (see prompt 0154's own evidence for that exact nuance). The TRIGGER
 * condition below (`hasPremiumEmojiContent`) already checked buttons for a
 * set `iconCustomEmojiId` since the day it was written in 0153 — confirmed
 * by reading its own body, not assumed — so button-icon-only content was
 * already correctly raising the warning before this prompt. The actual gap
 * this prompt closes is the WORDING: the warning text itself only ever
 * mentioned "emoji premium" (text emoji), never the button icon it was
 * ALSO (correctly) firing for — see ComposePage.jsx/WelcomePage.jsx for the
 * corrected copy.
 */

/** True if any premiumEmoji node exists anywhere in a TipTap doc (Title or Message). */
export function docContainsPremiumEmoji(doc) {
  if (!doc) return false;
  function walk(node) {
    if (!node) return false;
    if (node.type === 'premiumEmoji') return true;
    return (node.content || []).some(walk);
  }
  return walk(doc);
}

/** True if any button in the list has a premium icon set. */
export function buttonsContainPremiumIcon(buttons) {
  return (buttons || []).some((b) => Boolean(b?.iconCustomEmojiId));
}

/** True if EITHER doc (Title/Message/Welcome body) or any button carries premium-emoji content. */
export function hasPremiumEmojiContent({ titleDoc, bodyDoc, buttons } = {}) {
  return docContainsPremiumEmoji(titleDoc) || docContainsPremiumEmoji(bodyDoc) || buttonsContainPremiumIcon(buttons);
}

/**
 * The actual condition: only ever shown when there's real premium content
 * to warn about, AND the send would genuinely degrade it — the trial bot
 * (proven to silently drop `<tg-emoji>`/icons in prompt 0151's own spike),
 * or a channel target (excluded outright by Telegram's own Bot API 9.4
 * changelog, never actually tested live — see formatting.js's own
 * degradeForChannel() header). `targetType` is omitted/undefined for
 * Welcome, which has no channel concept at all — the condition still
 * degrades correctly to "only the trial-bot half matters" in that case.
 */
export function shouldShowPremiumEmojiWarning({ hasPremiumContent, botId, targetType }) {
  if (!hasPremiumContent) return false;
  return botId === 'test' || targetType === 'channel';
}
