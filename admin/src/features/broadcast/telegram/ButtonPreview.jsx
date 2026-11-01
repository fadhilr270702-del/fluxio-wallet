import React from 'react';
import PremiumEmojiStatic from './PremiumEmojiStatic.jsx';

/**
 * Prompt 0155 — the one shared way every READ surface renders a stored
 * button's label (Telegram's own icon-then-label order, matching what
 * actually shows up in a real Telegram client — see this prompt's own
 * archive for a screenshot proving that order). Used by ViewBroadcastModal,
 * BroadcastDetailPage, and WelcomeVersionViewModal — the three places that
 * render a broadcast/welcome's stored button list read-only. Deliberately
 * NOT used by ButtonPremiumIconControl.jsx (the Compose/Welcome EDITING
 * control) — that component combines the icon preview with its own Remove
 * button and picker-trigger button, a genuinely different concern from a
 * plain read-only label; forcing it through this presentational-only
 * component would either change its markup or need render-prop plumbing
 * for no real benefit, so it keeps its own small inline
 * `<PremiumEmojiStatic>` call instead, unchanged by this prompt.
 *
 * Static, never animated (PremiumEmojiStatic, not PremiumEmojiAnimated) —
 * same "static thumbnail for list/table surfaces" rule prompt 0153
 * established for title/body rendering. `iconCustomEmojiId` absent, null,
 * or an empty string are all already falsy in JS, so a plain truthiness
 * check is the entire "normalization" this needs — no separate pure helper
 * to extract or unit-test (see the prompt's own archive for why this was
 * confirmed rather than assumed). A missing/removed asset falls back to
 * PremiumEmojiStatic's own existing behavior (the fallback emoji character,
 * or nothing if there's no fallback text to show for a button icon) — this
 * component adds no extra fallback logic of its own on top of that.
 *
 * Prompt 0161 — no longer takes a `botId` prop at all: it was a pure
 * relay (never used here directly, only forwarded to the nested
 * `PremiumEmojiStatic`), which now resolves its own via
 * `<DataBotProvider>`/`useResolvedBotId()` instead. Every existing caller
 * (`ViewBroadcastModal`, `BroadcastDetailPage`, `WelcomeVersionViewModal`)
 * already renders inside the correct provider by the time this mounts.
 */
export default function ButtonPreview({ text, iconCustomEmojiId }) {
  return (
    <>
      {iconCustomEmojiId ? <PremiumEmojiStatic customEmojiId={iconCustomEmojiId} size={16} alt="" /> : null}
      {text}
    </>
  );
}
