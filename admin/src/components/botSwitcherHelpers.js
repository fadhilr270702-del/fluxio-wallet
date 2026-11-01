/**
 * Pure decision logic behind the sidebar account switcher's overwrite-style
 * guard (prompt 0139) — kept framework-free so it's directly unit-testable,
 * same reasoning as composeRecentCards.js's own pure helpers. The switcher
 * component (BotSwitcher.jsx) owns all the actual state/Modal rendering;
 * this is just "should it even ask".
 */

/**
 * True only when switching to a genuinely different bot AND the currently
 * mounted page reports unsaved content (via BotContext's dirty-check
 * registry — see useBotSwitchGuard.js). Re-selecting the already-active bot
 * is always a no-op regardless of dirtiness — there is nothing to lose by
 * "switching" to where you already are.
 */
export function shouldConfirmBotSwitch(currentBotId, nextBotId, isDirty) {
  if (currentBotId === nextBotId) return false;
  return Boolean(isDirty);
}

/**
 * The switch-confirm dialog's own copy + which actions it offers (prompt
 * 0142) — derived purely from whether the currently-dirty page has a
 * registered save action (Welcome does; Compose never does, a broadcast
 * draft has no storage of its own). Kept pure and framework-free, same
 * reasoning as shouldConfirmBotSwitch above — BotSwitchConfirmModal.jsx
 * owns all the actual rendering/loading-state/error-display; this is just
 * "what should it say, and can Save even be offered".
 *
 * `pageName` is only used for display when `hasSaveAction` is true (a
 * page with no save action is generically "the current form" in the
 * copy — Compose is the only such page today, but this doesn't hardcode
 * its name, matching the same "don't hardcode the one case that exists
 * today" caution botSwitcherHelpers.js's own isMediaUncopyable-style
 * siblings already follow).
 */
export function buildBotSwitchDialogContent({ pageName, targetLabel, hasSaveAction }) {
  if (hasSaveAction) {
    return {
      canSave: true,
      message: `Form ${pageName} saat ini masih berisi konten yang belum disimpan. Simpan dulu, atau buang, sebelum beralih ke “${targetLabel}”.`
    };
  }
  return {
    canSave: false,
    message: `Form saat ini masih berisi draf yang belum dikirim — draf broadcast tidak bisa disimpan. Beralih ke “${targetLabel}” akan membuangnya.`
  };
}
