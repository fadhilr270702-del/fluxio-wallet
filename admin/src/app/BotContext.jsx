import React, { createContext, useCallback, useRef, useState } from 'react';
import { shouldConfirmBotSwitch } from '../components/botSwitcherHelpers.js';

/**
 * The account-switcher's bot identity (prompt 0139, Stage B of the dual-bot
 * arc — see prompt 0138's own backend foundation). Mirrors
 * backend/src/telegram/botIds.js's enum exactly ('test' | 'official') —
 * this is intentionally NOT re-derived from an API call; there are exactly
 * two bots, known at build time, same YAGNI reasoning 0138 already applied
 * server-side.
 */
export const DEFAULT_BOT_ID = 'test';

/**
 * Display metadata for the switcher UI — label + the real Telegram username
 * each bot resolves to (used verbatim in the send-guard confirmation copy,
 * see sendGuard.js). Kept as a small static table here rather than fetched
 * from `getTelegramStatus()` per bot on every render: the switcher itself
 * needs to render its two rows immediately on mount, before any network
 * round trip could possibly return.
 */
// `initial` is its own explicit field, not derived from `label.charAt(0)` —
// both labels start with "Bot ", which would make both switcher avatars
// show the same letter (caught via a real screenshot during this prompt's
// own verification, not just by inspection).
export const BOT_CONTEXTS = {
  test: { id: 'test', label: 'Bot Percobaan', username: 'PercobaanPanel_bot', initial: 'P' },
  official: { id: 'official', label: 'Bot Resmi', username: 'FluxioWallet_bot', initial: 'R' }
};

/**
 * The other bot, given one — mirrors backend/src/telegram/botIds.js's own
 * otherBotId() exactly (only ever meaningful with exactly two bots — see
 * that file's own header). Used by WelcomePage.jsx's "Salin ke bot lain"
 * (prompt 0141): the target is never chosen explicitly, it's always
 * whichever bot isn't the one currently active.
 */
export function otherBotId(botId) {
  return Object.keys(BOT_CONTEXTS).find((id) => id !== botId);
}

// Prompt 0139's own explicit design requirement: a plain page refresh must
// reset the switcher to 'test' (see this prompt's own verification item
// 7g) — the same safety requirement item 1 states for a brand-new tab.
// Plain in-memory React state already satisfies this on its own (nothing
// here persists across a reload) — an earlier revision also mirrored every
// switch into sessionStorage under a BOT_STORAGE_KEY, but nothing ever read
// that key back, so it was a write with no reader. Removed rather than kept
// "for later": a persistence layer with no consumer is dead code, not a
// hook worth keeping around.
export const BotContext = createContext(null);

export function BotContextProvider({ children }) {
  const [botId, setBotId] = useState(DEFAULT_BOT_ID);

  // A dirty-form-check registry, not a prop — the switcher lives in the
  // Sidebar (always mounted) while the actual "does the current page have
  // unsaved content" answer only Compose/Welcome (and only in their
  // create/edit form state) know how to compute, and neither is a sibling
  // of Sidebar in the tree. The currently-mounted page registers its own
  // check function on mount and unregisters it on unmount; a page that
  // never registers (every non-Telegram page, plus History, which has no
  // form to protect) simply leaves this at null, so the switch is always
  // frictionless there — matching "Halaman non-Telegram tidak tersentuh
  // konteks" and History's own read-only nature.
  const dirtyCheckRef = useRef(null);

  const registerDirtyCheck = useCallback((fn) => {
    dirtyCheckRef.current = fn;
    return () => {
      if (dirtyCheckRef.current === fn) dirtyCheckRef.current = null;
    };
  }, []);

  const isCurrentFormDirty = useCallback(() => {
    return dirtyCheckRef.current ? Boolean(dirtyCheckRef.current()) : false;
  }, []);

  // Prompt 0142 — a SECOND, independent registry alongside dirtyCheckRef:
  // whether the currently-mounted dirty page can actually SAVE its own
  // draft (Welcome can — a real, persisted config; Compose can't — a
  // broadcast draft has no storage of its own, a deliberate scope cut, see
  // ComposePage.jsx's own comment). Only Welcome ever calls
  // registerSwitchSaveAction (via useBotSwitchSaveAction) — Compose simply
  // never does, so this stays null for it and the switch-confirm dialog
  // renders its own no-save variant. `pageName` is plain display text
  // ("Welcome") for the dialog's own wording — never used for branching
  // logic, that's what the presence/absence of `save` itself is for.
  const saveActionRef = useRef(null);

  const registerSwitchSaveAction = useCallback((save, pageName) => {
    const entry = save ? { save, pageName } : null;
    saveActionRef.current = entry;
    return () => {
      if (saveActionRef.current === entry) saveActionRef.current = null;
    };
  }, []);

  // Read as a plain function call, not a context VALUE, deliberately — see
  // isCurrentFormDirty's own identical reasoning above (a ref change alone
  // never triggers a re-render, so a pre-computed value here could go
  // stale between renders; a getter always reads the ref fresh at the
  // moment it's actually needed, which for the switch-confirm dialog is
  // exactly when it renders in response to pendingBotSwitch changing —
  // always AFTER whichever page is currently mounted has already run its
  // own registration effect).
  const getSwitchSaveAction = useCallback(() => saveActionRef.current, []);

  // Prompt 0142 — the guarded switch flow itself, centralized here rather
  // than inside BotSwitcher.jsx (which lives inside `.sidebar`) so the
  // confirmation Modal can be RENDERED from AppShell.jsx instead — see
  // that file's own comment for why: `.sidebar` picks up
  // `backdrop-filter` under the `@supports` glass-panel rule in
  // admin.css, and `backdrop-filter` (like `transform`/`filter`) creates a
  // new containing block for `position:fixed` descendants, which is
  // exactly what squeezed the old in-sidebar dialog into the sidebar's own
  // narrow box instead of centering over the whole viewport. Moving the
  // dialog's actual JSX out from under `.sidebar` is the real fix; this
  // context is what lets BotSwitcher (still inside the sidebar) and
  // AppShell (a sibling of it) share one guarded-switch state machine
  // without prop-drilling through Sidebar.jsx.
  const [pendingBotSwitch, setPendingBotSwitch] = useState(null); // next bot id, or null when no confirm is pending

  const requestBotSwitch = useCallback((nextBotId) => {
    if (shouldConfirmBotSwitch(botId, nextBotId, isCurrentFormDirty())) {
      setPendingBotSwitch(nextBotId);
      return;
    }
    if (nextBotId !== botId) setBotId(nextBotId);
  }, [botId, isCurrentFormDirty]);

  const cancelBotSwitch = useCallback(() => setPendingBotSwitch(null), []);

  // "Buang dan beralih" — the original, honest discard behavior: switches
  // immediately, the currently-mounted page's own unsaved edits are simply
  // left behind (it's about to unmount anyway).
  const discardAndSwitchBot = useCallback(() => {
    setPendingBotSwitch((pending) => {
      if (pending) setBotId(pending);
      return null;
    });
  }, []);

  // "Simpan dan beralih" — runs the CURRENTLY registered save action for
  // real (full validation included, since it's the exact same save path
  // the page's own Save button uses — see WelcomePage.jsx's performSave()).
  // Only switches (and clears pendingBotSwitch) on success; a failure
  // leaves pendingBotSwitch untouched so the dialog stays open showing the
  // same error the form itself would show, and nothing about the form's
  // own in-progress content is lost (the page under the dialog never
  // unmounted). Returns the save action's own {success, error} shape so
  // the dialog component can render the error without needing its own
  // separate error-reading path.
  const saveAndSwitchBot = useCallback(async () => {
    const action = saveActionRef.current;
    if (!action) return { success: false, error: 'Nothing to save.' }; // defensive — the dialog never offers this button without a registered action
    const result = await action.save();
    if (result.success) {
      setPendingBotSwitch((pending) => {
        if (pending) setBotId(pending);
        return null;
      });
    }
    return result;
  }, []);

  const value = {
    botId,
    setBotId,
    botMeta: BOT_CONTEXTS[botId],
    registerDirtyCheck,
    isCurrentFormDirty,
    registerSwitchSaveAction,
    getSwitchSaveAction,
    pendingBotSwitch,
    requestBotSwitch,
    cancelBotSwitch,
    discardAndSwitchBot,
    saveAndSwitchBot
  };

  return <BotContext.Provider value={value}>{children}</BotContext.Provider>;
}
