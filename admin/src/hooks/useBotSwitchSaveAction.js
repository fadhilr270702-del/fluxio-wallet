import { useEffect } from 'react';
import useBotContext from './useBotContext.js';

/**
 * Registers the calling page's own real save action with BotContext's
 * switch-save registry (prompt 0142) — sibling to useBotSwitchGuard.js's
 * dirty-check registration, but optional: only a page whose draft is
 * actually persisted (Welcome — a real, versioned config) ever calls this.
 * Compose never does, since a broadcast draft has no storage of its own
 * (a deliberate scope cut, see ComposePage.jsx's own comment) — leaving
 * this unregistered is what makes the switch-confirm dialog fall back to
 * its no-save "Buang dan beralih"-only variant for Compose.
 *
 * `saveFn` must return `Promise<{success: boolean, error?: string}>` —
 * never throw — so the dialog can render a failure inline without its own
 * try/catch. `pageName` is plain display text for the dialog's own wording
 * ("Welcome"), never used for branching (the presence/absence of a
 * registered action itself is what branches the dialog).
 */
export default function useBotSwitchSaveAction(saveFn, pageName) {
  const { registerSwitchSaveAction } = useBotContext();
  useEffect(() => registerSwitchSaveAction(saveFn, pageName), [registerSwitchSaveAction, saveFn, pageName]);
}
