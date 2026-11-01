import useDataBotId from './useDataBotId.js';
import { resolveDataBotId } from '../app/resolveDataBotId.js';

/**
 * Prompt 0161 — the one thing every genuine premium-emoji-asset consumer
 * calls: reads the ambient `<DataBotProvider>` value, resolves it against
 * whatever `propBotId` that component itself received (see
 * `resolveDataBotId.js`'s own header for the exact rule), and — the
 * actual point of this whole prompt — makes a missing resolution LOUD
 * rather than a silently-empty placeholder. `componentName` is plain
 * literal text passed by each call site (`'PremiumEmojiStatic'`,
 * `'RichTextEditor'`, ...) specifically so a real "why is this emoji
 * blank" investigation starts from a `console.error` naming the exact
 * component and explaining the fix, instead of a bug report and a cold
 * grep through every file that touches `botId` (which is exactly how
 * prompts 0153 and 0155 each had to be individually diagnosed the hard
 * way before this hook existed).
 *
 * Dev-only (`import.meta.env.DEV`) — matches the same gate this codebase
 * already uses for build-time dead-code elimination of dev-only logging;
 * a production build never emits this even if a real deployment somehow
 * hits the missing case.
 *
 * Prompt 0163 — `{ silent }` lets a caller whose premium-emoji concept is
 * entirely disabled for this instance (RichTextEditor's own
 * `premiumEnabled={false}` mode, used by Announcements/Versions — neither
 * is a Telegram concept, so there's no botId to resolve and no
 * `<DataBotProvider>` anywhere in that page's tree by design, not by
 * oversight) skip resolution AND the warning entirely, resolving to `null`
 * unconditionally. `useDataBotId()` is still called every time regardless
 * of `silent` — this hook is called unconditionally by every one of its
 * own callers already (React's rules of hooks), so varying its OWN
 * internal behavior via an argument, rather than the CALLER conditionally
 * calling this hook at all, is what keeps that guarantee intact.
 */
export default function useResolvedBotId(propBotId, componentName, { silent = false } = {}) {
  const contextBotId = useDataBotId();
  if (silent) return null;
  const { botId, source } = resolveDataBotId(propBotId, contextBotId);
  if (source === 'missing' && import.meta.env.DEV) {
    console.error(
      `[${componentName}] no botId available for resolving a premium-emoji asset — ` +
        'pass an explicit botId prop, or render this component inside <DataBotProvider>. ' +
        'Falling back to the plain fallback character/text; no asset will be fetched.'
    );
  }
  return botId;
}
