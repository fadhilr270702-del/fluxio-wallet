/**
 * Prompt 0161 — the pure half of premium-emoji botId resolution, kept
 * dependency-free (no React import at all) specifically so it has direct,
 * framework-free test coverage, same reasoning as `cursorInsert.js`/
 * `isRectNearViewport.js` before it.
 *
 * The rule, exactly as CLAUDE.md's own permanent-lessons entry (prompt
 * 0158, extended by this prompt) describes it: an explicit `propBotId`
 * always wins when given; otherwise the ambient `contextBotId` (from
 * `<DataBotProvider>`, read via `useDataBotId()`) is used; if NEITHER is
 * available, this deliberately returns `null` rather than silently
 * falling back to whatever bot the switcher happens to be pointed at —
 * the whole point of this refactor is that "which bot is active right
 * now" and "which bot actually owns this data" are two different
 * questions, and conflating them again here would just reintroduce the
 * same class of bug (0153/0155) this exists to close.
 *
 * `source` in the return value exists so a caller (see
 * `hooks/useResolvedBotId.js`) can tell a genuine resolution apart from
 * the failure case without re-deriving that from `botId` alone (`null` is
 * itself a valid-looking falsy value that could theoretically arise some
 * other way in a more complex future caller — an explicit `'missing'`
 * reason is unambiguous).
 *
 * Both inputs are treated as "not given" via plain truthiness — `''`,
 * `null`, and `undefined` are all already indistinguishable as "nothing
 * usable" (same convention `ButtonPreview.jsx`'s own header already
 * established for `iconCustomEmojiId`), so no separate normalization step
 * is needed for either argument.
 */
export function resolveDataBotId(propBotId, contextBotId) {
  if (propBotId) return { botId: propBotId, source: 'prop' };
  if (contextBotId) return { botId: contextBotId, source: 'context' };
  return { botId: null, source: 'missing' };
}
