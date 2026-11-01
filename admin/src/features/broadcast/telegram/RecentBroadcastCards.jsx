import React, { useState } from 'react';
import Badge from '../../../components/Badge.jsx';
import Icon from '../../../components/Icon.jsx';
import Modal from '../../../components/Modal.jsx';
import { formatDate } from '../../../utils/formatDate.js';
import { TARGET_TYPE_LABELS, recurringProgressLabel } from './telegramBroadcastStatus.js';
import { broadcastPlainTextExcerpt, mediaSkipReasonNote, titlePlainText } from './composeRecentCards.js';
import { deactivateRecurringBroadcast } from '../../../services/telegramBroadcastApi.js';
import FormattedTelegramText from './FormattedTelegramText.jsx';
import { DataBotProvider } from '../../../app/DataBotContext.jsx';

/**
 * "Broadcast terakhir" — the 12 most recent broadcasts (widened from 5 in
 * prompt 0132 Revision 2), shown as cards below
 * the Compose form (create mode only, see ComposePage.jsx). Deliberately a
 * separate, additional window onto the same data the History tab already
 * shows in full via BroadcastHistoryTable.jsx — not a replacement, and not
 * merged with it (see prompt 0132's own explicit instruction not to
 * refactor the two into one component).
 *
 * No thumbnails for attached media: a Telegram `file_id` isn't a URL and
 * can't be rendered directly without a backend round trip to fetch/proxy
 * the actual file — a deliberate, documented scope cut (prompt 0132), so
 * media is shown as an icon+label badge only.
 *
 * Recurring support (prompt 0134): the status Badge already renders
 * "Recurring" in its own distinct color once a card's own `status` is
 * literally `'recurring'` — that alone is the "badge/tanda jelas" the
 * prompt asked for, no separate marker invented. A card with an actively
 * running recurring broadcast also shows its running "Sent N×, last HH:MM"
 * tally and a "Deactivate" button (confirmed via the existing Modal.jsx
 * before actually calling the endpoint — this is a one-way action with a
 * real side effect, not something a stray click should trigger).
 */
export default function RecentBroadcastCards({ broadcasts, loading, error, onCopyToForm, onView, onDeactivated }) {
  const [deactivateConfirm, setDeactivateConfirm] = useState(null);
  const [deactivating, setDeactivating] = useState(false);
  const [deactivateError, setDeactivateError] = useState(null);

  async function handleConfirmDeactivate() {
    if (!deactivateConfirm) return;
    setDeactivating(true);
    setDeactivateError(null);
    try {
      await deactivateRecurringBroadcast(deactivateConfirm.id);
      setDeactivateConfirm(null);
      onDeactivated();
    } catch (err) {
      setDeactivateError(err.message || 'Could not deactivate this recurring broadcast.');
    } finally {
      setDeactivating(false);
    }
  }

  if (loading) return <div className="loading-state">Loading…</div>;
  if (error) return <div className="form-error">{error}</div>;
  if (broadcasts.length === 0) {
    return <div className="data-table__empty">No broadcasts sent yet — your first one will show up here.</div>;
  }

  return (
    <>
      <div className="recent-broadcasts__grid">
        {broadcasts.map((b) => {
          // No longer bot-dependent as of prompt 0141 — fires only for
          // genuinely legacy media with no server file to carry forward
          // (see composeRecentCards.js's own comment).
          const mediaNote = mediaSkipReasonNote(b);
          const buttonCount = (b.buttons || []).length;
          const isActiveRecurring = b.status === 'recurring';
          const recurringLabel = recurringProgressLabel(b);
          return (
            // Prompt 0161 — one <DataBotProvider value={b.bot}> per card,
            // same reasoning as BroadcastHistoryTable's own per-row wrap:
            // this card's title resolves against THIS broadcast's own
            // bot, not whichever one the switcher currently shows.
            <DataBotProvider key={b.id} value={b.bot}>
              <div className="card recent-broadcast-card">
                <div className="recent-broadcast-card__head">
                  <div className="recent-broadcast-card__title">
                    <FormattedTelegramText text={b.title} format={b.titleFormat} />
                  </div>
                  <Badge value={b.status} kind="broadcastStatus" />
                </div>
              <p className="recent-broadcast-card__excerpt">{broadcastPlainTextExcerpt(b)}</p>
              {recurringLabel && <p className="recent-broadcast-card__recurring">{recurringLabel}</p>}
              <div className="recent-broadcast-card__meta">
                {b.mediaType && (
                  <span className="recent-broadcast-card__badge">
                    <Icon name={b.mediaType === 'video' ? 'video' : 'image'} /> {b.mediaType === 'video' ? 'Video' : 'Image'}
                  </span>
                )}
                {buttonCount > 0 && (
                  <span className="recent-broadcast-card__badge">
                    {buttonCount} button{buttonCount === 1 ? '' : 's'}
                  </span>
                )}
                <span className="recent-broadcast-card__meta-item">{TARGET_TYPE_LABELS[b.targetType]}</span>
                <span className="recent-broadcast-card__meta-item">{formatDate(b.createdAt)}</span>
              </div>
              {mediaNote && <p className="field-hint">{mediaNote}</p>}
              <div className="recent-broadcast-card__actions">
                <button type="button" className="btn btn-sm" onClick={() => onView(b)}>
                  View
                </button>
                <button type="button" className="btn btn-sm" onClick={() => onCopyToForm(b)}>
                  <Icon name="copy" /> Salin ke form
                </button>
                {isActiveRecurring && (
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => setDeactivateConfirm(b)}>
                    Deactivate
                  </button>
                )}
              </div>
              </div>
            </DataBotProvider>
          );
        })}
      </div>

      {deactivateConfirm && (
        <Modal title="Deactivate recurring broadcast?" onClose={() => (deactivating ? null : setDeactivateConfirm(null))}>
          {deactivateError && <div className="form-error" style={{ marginBottom: 16 }}>{deactivateError}</div>}
          <p>
            No more automatic sends will happen for &ldquo;{titlePlainText(deactivateConfirm.title, deactivateConfirm.titleFormat)}&rdquo;. It stays in History with
            its final count.
          </p>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setDeactivateConfirm(null)} disabled={deactivating}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger" onClick={handleConfirmDeactivate} disabled={deactivating}>
              {deactivating ? 'Deactivating…' : 'Deactivate'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
