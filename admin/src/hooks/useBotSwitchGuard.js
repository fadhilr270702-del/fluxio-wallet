import { useEffect } from 'react';
import useBotContext from './useBotContext.js';

/**
 * Registers the calling page's own "does my form currently have unsaved
 * content" check with BotContext's dirty-check registry (see
 * BotContext.jsx's own comment on why this is a registry, not a prop) — the
 * bot switcher in the Sidebar calls it before actually switching, prompting
 * an overwrite-style confirm (same Modal pattern as prompt 0132's own
 * "Salin ke form"/"Muat ke form" guards) only when it returns true.
 *
 * `isDirtyFn` should be a stable-enough closure over the calling page's own
 * form state (e.g. `() => !isComposeFormEmpty(fields, bodyDoc)`) — it's
 * re-registered on every dependency change and unregistered on unmount, so
 * navigating away always leaves the registry clean for whatever page (or
 * nothing) mounts next.
 */
export default function useBotSwitchGuard(isDirtyFn) {
  const { registerDirtyCheck } = useBotContext();
  useEffect(() => registerDirtyCheck(isDirtyFn), [registerDirtyCheck, isDirtyFn]);
}
