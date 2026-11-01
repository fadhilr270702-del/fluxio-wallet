import React, { useState } from 'react';
import Modal from './Modal.jsx';
import useBotContext from '../hooks/useBotContext.js';
import { BOT_CONTEXTS } from '../app/BotContext.jsx';
import { buildBotSwitchDialogContent } from './botSwitcherHelpers.js';

/**
 * The bot-switcher's overwrite-style confirmation (prompt 0139, relocated
 * and extended in prompt 0142) — rendered from AppShell.jsx, a sibling of
 * `.sidebar` in the DOM, not a descendant of it. That relocation is the
 * actual fix for a real visual bug: BotSwitcher.jsx (where this dialog
 * used to render its own Modal) lives inside `.sidebar`, and `.sidebar`
 * picks up `backdrop-filter` under admin.css's `@supports` glass-panel
 * rule — `backdrop-filter` creates a new containing block for
 * `position:fixed` descendants (the same as `transform`/`filter` would),
 * which squeezed the old dialog into the sidebar's own narrow box instead
 * of centering over the whole viewport. No CSS change to Modal.jsx or
 * `.modal-overlay` was needed or made — every other Modal in this app
 * already renders from a page's own main-content component (never from
 * inside `.sidebar`), which is why only this one dialog was ever affected.
 *
 * Two variants, chosen purely by whether the currently-dirty page
 * registered a save action (see useBotSwitchSaveAction.js) — Welcome does
 * (a real, versioned config); Compose never does (a broadcast draft has no
 * storage of its own, a deliberate scope cut). See
 * botSwitcherHelpers.js's buildBotSwitchDialogContent() for the actual
 * pure copy/branching logic this component just renders.
 *
 * "Simpan dan beralih" runs the registered save action for real — full
 * validation included, since it's the exact same save path the page's own
 * Save button uses (see WelcomePage.jsx's performSave()). A failure keeps
 * this dialog open with the same error message the form itself would show
 * (never a silent swallow, never a switch anyway) — the page under the
 * dialog never unmounts on failure, so nothing about its in-progress
 * content is lost. `saving` disables every action button so a slow request
 * can't be double-submitted by an impatient extra click.
 */
export default function BotSwitchConfirmModal() {
  // AppShell.jsx only ever mounts this component while pendingBotSwitch is
  // truthy (conditional render, not an internal early-return) — see that
  // file's own comment for why that matters (fresh saving/error state per
  // switch attempt, not carried over from a previous one).
  const { pendingBotSwitch, cancelBotSwitch, discardAndSwitchBot, saveAndSwitchBot, getSwitchSaveAction } = useBotContext();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const saveAction = getSwitchSaveAction();
  const targetMeta = BOT_CONTEXTS[pendingBotSwitch];
  const { canSave, message } = buildBotSwitchDialogContent({
    pageName: saveAction?.pageName,
    targetLabel: targetMeta.label,
    hasSaveAction: Boolean(saveAction)
  });

  async function handleSaveAndSwitch() {
    setSaving(true);
    setSaveError(null);
    const result = await saveAndSwitchBot();
    // On success saveAndSwitchBot() already cleared pendingBotSwitch, so
    // this component's very next render returns null above — no separate
    // "success" branch needed here.
    if (!result.success) {
      setSaveError(result.error || 'Could not save.');
      setSaving(false);
    }
  }

  return (
    <Modal title="Ganti konteks bot?" onClose={() => { if (!saving) cancelBotSwitch(); }}>
      {saveError && <div className="form-error" style={{ marginBottom: 16 }}>{saveError}</div>}
      <p>{message}</p>
      <div className="form-actions">
        <button type="button" className="btn" onClick={cancelBotSwitch} disabled={saving}>
          Batal
        </button>
        <button type="button" className="btn" onClick={discardAndSwitchBot} disabled={saving}>
          Buang dan beralih
        </button>
        {canSave && (
          <button type="button" className="btn btn-primary" onClick={handleSaveAndSwitch} disabled={saving}>
            {saving ? 'Menyimpan…' : 'Simpan dan beralih'}
          </button>
        )}
      </div>
    </Modal>
  );
}
