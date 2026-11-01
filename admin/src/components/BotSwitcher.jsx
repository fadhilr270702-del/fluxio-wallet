import React from 'react';
import useBotContext from '../hooks/useBotContext.js';
import { BOT_CONTEXTS, DEFAULT_BOT_ID } from '../app/BotContext.jsx';

const ORDER = [DEFAULT_BOT_ID, 'official'];

/**
 * Sidebar account switcher (prompt 0139) — two rows, one per bot, styled
 * like a small account picker (avatar-initial + name + active indicator),
 * matching the existing `.avatar` treatment Navbar.jsx already uses for the
 * admin's own identity rather than inventing a new avatar shape. Rendered
 * as the last thing in Sidebar.jsx, pinned to the sidebar's bottom via
 * `.bot-switcher`'s own `margin-top:auto` (prompt 0189 — the collapse
 * toggle that used to sit below it was removed).
 *
 * Prompt 0142 — this component no longer owns the confirm dialog itself
 * (it used to render its own `<Modal>` right here, which is exactly what
 * squeezed it into `.sidebar`'s own narrow box — see
 * BotSwitchConfirmModal.jsx's own header comment for the full CSS
 * explanation). It just asks BotContext to attempt the switch;
 * BotContext's own requestBotSwitch() decides whether that needs
 * confirmation (via the same dirty-check registry as before) and, if so,
 * sets the shared `pendingBotSwitch` state that AppShell.jsx's
 * `<BotSwitchConfirmModal/>` — a sibling of `.sidebar`, not a descendant —
 * actually renders from.
 */
export default function BotSwitcher() {
  const { botId, requestBotSwitch } = useBotContext();

  return (
    <div className="bot-switcher" role="group" aria-label="Bot context">
      {ORDER.map((id) => {
        const meta = BOT_CONTEXTS[id];
        const isActive = id === botId;
        const isOfficial = id === 'official';
        return (
          <button
            key={id}
            type="button"
            className={`bot-switcher__item${isActive ? ' bot-switcher__item--active' : ''}${isOfficial ? ' bot-switcher__item--official' : ''}`}
            onClick={() => requestBotSwitch(id)}
            aria-pressed={isActive}
          >
            <span className="bot-switcher__avatar">{meta.initial}</span>
            <span className="bot-switcher__text">
              <span className="bot-switcher__label">{meta.label}</span>
              <span className="bot-switcher__username">@{meta.username}</span>
            </span>
            {isActive && <span className="bot-switcher__dot" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}
