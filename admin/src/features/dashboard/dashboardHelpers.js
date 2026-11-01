/**
 * Pure helpers backing Dashboard.jsx's dual-bot-aware widgets (prompt
 * 0143) — kept framework-free and side-effect-free so they're directly
 * unit-testable, same reasoning as composeRecentCards.js/
 * botSwitcherHelpers.js's own pure helpers. Dashboard.jsx owns all the
 * actual fetching/state.
 */

/**
 * The "Telegram subscribers" tile's OTHER-bot pill (prompt 0190, replacing
 * 0143's plain-string formatOtherBotSubscriberHint — that second hint line
 * styled identically to "Active" read like a mislabeled duplicate, per the
 * owner's own report). Returns the { label, count } StatTile's `otherBot`
 * pill renders (count already resolved by the caller — a real number, or
 * "—" while loading), or null on a failed fetch for the other bot
 * (StatTile renders nothing then) rather than a misleading placeholder
 * dressed up as real data.
 */
export function buildOtherBotPill(otherBotLabel, otherCount, hasError) {
  if (hasError) return null;
  return { label: otherBotLabel, count: otherCount };
}

/**
 * Prompt 0235 — the "New subscribers (7 days)" tile's delta hint against
 * the previous rolling 7 day window. Pure; returns a plain sentence
 * fragment with no hyphen (a negative delta's own minus sign is a number,
 * not prose). Nullish inputs (older backend, still loading) degrade to the
 * plain window label rather than a bogus delta.
 */
export function newSubscribersDeltaHint(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return 'Last 7 days';
  }
  const diff = current - previous;
  if (diff === 0) return 'Same as previous 7 days';
  return `${diff > 0 ? '+' : ''}${diff} vs previous 7 days`;
}
