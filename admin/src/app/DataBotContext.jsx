import React, { createContext } from 'react';

/**
 * Prompt 0161 — "which bot owns the data currently on screen", a
 * DIFFERENT question from `BotContext.jsx`'s own "which bot is the
 * switcher currently pointed at". The two happen to share the same value
 * at a Compose/Welcome/Premium-Emoji-library boundary (composing/managing
 * IS scoped to the active bot) — but for anything rendering ALREADY-SAVED
 * data (a History row, a Recent card, a Detail page, a View modal, a
 * Welcome version), the correct bot is whichever one actually created that
 * data (`broadcast.bot`, read straight from the row), which can silently
 * differ from wherever the switcher happens to be pointed right now (e.g.
 * a fresh page load always resets the switcher to `'test'`, independent of
 * which broadcast a deep link opens — see `BotContext.jsx`'s own comment).
 *
 * See CLAUDE.md's own "Premium emoji feature — permanent lessons" entry
 * #3 (prompt 0158) for why this exists: `botId` used to be threaded by
 * hand as a prop into every component that resolves a premium-emoji
 * asset, and it leaked (silently rendered nothing) twice independently
 * across prompts 0153 and 0155. This context is the structural fix that
 * entry named as "worth considering, not yet done" — now done.
 *
 * Deliberately NOT a single app-wide provider the way `BotContextProvider`
 * is (mounted once in `main.jsx`, wrapping the entire app) — this is
 * installed repeatedly, at each place in the tree that actually KNOWS
 * which bot owns the data it's about to render: `ComposePage`/
 * `WelcomePage`/`EmojiLibraryPage` (using the active bot — the "compose/
 * manage" boundary), and `ViewBroadcastModal`/`BroadcastDetailPage`/each
 * `BroadcastHistoryTable` row/each `RecentBroadcastCards` card (using that
 * specific broadcast's own `.bot` field — the "read stored data" boundary).
 * A component nested inside more than one of these (e.g.
 * `RecentBroadcastCards` rendered inside `ComposePage`) sees whichever
 * provider is closest — ordinary, expected React context nesting, not a
 * new mechanism.
 *
 * No `useDataBotId()` hook lives in this file — see
 * `hooks/useDataBotId.js` (mirrors `BotContext.jsx`/`useBotContext.js`'s
 * own split) for why it's kept separate, and `hooks/useResolvedBotId.js`
 * for the actual resolve-and-warn logic every real consumer calls.
 * Deliberately does NOT throw when read outside any provider (unlike
 * `useBotContext()`, which throws — `BotContextProvider` is a hard,
 * app-wide requirement, this context is optional/scoped by design) —
 * reading it outside a provider just yields `null`, exactly what
 * `resolveDataBotId()` treats as "no context value available".
 */
export const DataBotContext = createContext(null);

export function DataBotProvider({ value, children }) {
  return <DataBotContext.Provider value={value}>{children}</DataBotContext.Provider>;
}
