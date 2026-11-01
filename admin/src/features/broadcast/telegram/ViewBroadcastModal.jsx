import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Modal from '../../../components/Modal.jsx';
import Badge from '../../../components/Badge.jsx';
import Icon from '../../../components/Icon.jsx';
import RichTextEditor from './RichTextEditor.jsx';
import { formatDate } from '../../../utils/formatDate.js';
import { TARGET_TYPE_LABELS, recurringProgressLabel } from './telegramBroadcastStatus.js';
import { bodyToEditorHtml } from './editorTelegramFormat.js';
import { fetchTelegramBroadcastMedia, deactivateRecurringBroadcast } from '../../../services/telegramBroadcastApi.js';
import { mediaSkipReasonNote, titlePlainText } from './composeRecentCards.js';
import FormattedTelegramText from './FormattedTelegramText.jsx';
import ButtonPreview from './ButtonPreview.jsx';
import { DataBotProvider } from '../../../app/DataBotContext.jsx';

/**
 * Read-only "View" for a "Broadcast terakhir" card (prompt 0132 Revision
 * 1) — deliberately mirrors the Compose form's own layout (same
 * .field/label markup, same field order: Title, Message, Image/Video,
 * Buttons, Target, When) so it reads as "the same form, frozen", not a
 * new page style. The message body is rendered through the exact same
 * TipTap pipeline Compose/Edit already use (`bodyToEditorHtml()` +
 * `RichTextEditor readOnly`) — see that component's own comment on why
 * this is the safe way to render a stored body as rich HTML, not a new
 * HTML-to-DOM renderer.
 *
 * Media rendering (prompt 0132 Revision 2) fetches the real image/video
 * bytes through the new authenticated proxy endpoint
 * (fetchTelegramBroadcastMedia -> Blob -> URL.createObjectURL) and shows
 * them as a genuine <img>/<video controls> — never the endpoint URL placed
 * directly in a src attribute (see fetchTelegramBroadcastMedia's own
 * comment for why). Falls back to the same icon+text badge from Revision 1
 * (now only actually reached on a load failure or for legacy `mediaUrl`
 * broadcasts, which were never fetchable this way to begin with — DetailPage's
 * own conditional pattern/wording, extended with an icon per Revision 1's
 * own ask).
 *
 * Actions row (prompt 0132 Revision 3) is passed via Modal's new `footer`
 * prop rather than left inside the scrollable body — a real image/video
 * preview plus a full frozen form can grow taller than the viewport, and
 * Close/Salin ke form/"Buka halaman detail" are the one thing a user should
 * never have to hunt for by scrolling to the very bottom, regardless of how
 * long the content above them gets. See Modal.jsx's own comment for how the
 * header/body/footer split actually works.
 *
 * Recurring support (prompt 0134): an active recurring broadcast shows its
 * own "Recurring" field with the running Sent-N×/last-sent tally, and the
 * footer gains a "Deactivate" button. Confirming deactivation REPLACES this
 * whole modal's content with a short confirm screen (still the same single
 * `<Modal>` element — `confirmingDeactivate` just changes what this
 * component returns) rather than opening a second `<Modal>` on top of this
 * one, for the same reason Revision 1's copy-to-form guard modal replaces
 * rather than stacks: `Modal.jsx`'s per-instance Escape-key listener has no
 * coordination between two simultaneously-mounted instances.
 */
export default function ViewBroadcastModal({ broadcast, onClose, onCopyToForm, onDeactivated }) {
  const hasRealMedia = Boolean(broadcast.mediaFileId);
  // Distinct from `isLegacyMedia` below (which only gates preview
  // capability): this is specifically "can 'Salin ke form' actually reuse
  // this broadcast's media", shown as its own note near the copy action so
  // an admin never silently loses media on copy. No longer bot-dependent
  // as of prompt 0141 — see composeRecentCards.js's own comment.
  const mediaNote = mediaSkipReasonNote(broadcast);
  const isLegacyMedia = Boolean(broadcast.mediaUrl) && !hasRealMedia;
  const bodyHtml = bodyToEditorHtml(broadcast.body, broadcast.bodyFormat);
  const buttons = broadcast.buttons || [];

  // 'idle' (no real media to fetch) | 'loading' | 'ready' | 'error'.
  // objectUrl is only ever set while status is 'ready', and is always
  // revoked — both on a broadcast-id change and on this component's own
  // unmount (which is exactly what happens when the modal closes, since
  // ComposePage conditionally renders this component rather than just
  // hiding it) — via this effect's own cleanup function.
  const [media, setMedia] = useState({ status: hasRealMedia ? 'loading' : 'idle', objectUrl: null, errorMessage: null });

  useEffect(() => {
    if (!hasRealMedia) return undefined;
    let canceled = false;
    let objectUrl = null;
    setMedia({ status: 'loading', objectUrl: null, errorMessage: null });
    fetchTelegramBroadcastMedia(broadcast.id)
      .then((blob) => {
        if (canceled) return;
        objectUrl = URL.createObjectURL(blob);
        setMedia({ status: 'ready', objectUrl, errorMessage: null });
      })
      .catch((err) => {
        if (canceled) return;
        // Falls back to the icon+text badge below — never a raw error UI,
        // per the prompt's own explicit instruction. The message is kept
        // (as a small note) since it's always one of this endpoint's own
        // safe, generic strings (see getMedia()'s own comment on why it
        // never forwards a raw underlying error) — never anything
        // sensitive.
        setMedia({ status: 'error', objectUrl: null, errorMessage: err.message || 'Could not load media preview.' });
      });
    return () => {
      canceled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [broadcast.id, hasRealMedia]);

  const isActiveRecurring = broadcast.status === 'recurring';
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [deactivateError, setDeactivateError] = useState(null);

  async function handleConfirmDeactivate() {
    setDeactivating(true);
    setDeactivateError(null);
    try {
      await deactivateRecurringBroadcast(broadcast.id);
      onDeactivated();
    } catch (err) {
      setDeactivateError(err.message || 'Could not deactivate this recurring broadcast.');
      setDeactivating(false);
    }
  }

  if (confirmingDeactivate) {
    return (
      <Modal
        title="Deactivate recurring broadcast?"
        onClose={() => {
          if (!deactivating) setConfirmingDeactivate(false);
        }}
      >
        {deactivateError && <div className="form-error" style={{ marginBottom: 16 }}>{deactivateError}</div>}
        <p>
          No more automatic sends will happen for &ldquo;{titlePlainText(broadcast.title, broadcast.titleFormat)}&rdquo;. It stays in History with its
          final count.
        </p>
        <div className="form-actions">
          <button type="button" className="btn" onClick={() => setConfirmingDeactivate(false)} disabled={deactivating}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={handleConfirmDeactivate} disabled={deactivating}>
            {deactivating ? 'Deactivating…' : 'Deactivate'}
          </button>
        </div>
      </Modal>
    );
  }

  const footer = (
    <div className="view-broadcast-modal__actions">
      {/* Read-only — every action that actually mutates a broadcast
          (cancel/reschedule) stays on the detail page, per the prompt's
          own instruction not to duplicate those here. */}
      <Link to={`/broadcast/history/${broadcast.id}`} className="view-broadcast-modal__detail-link">
        Buka halaman detail
      </Link>
      <div className="view-broadcast-modal__actions-right">
        {isActiveRecurring && (
          <button type="button" className="btn btn-danger" onClick={() => setConfirmingDeactivate(true)}>
            Deactivate
          </button>
        )}
        <button type="button" className="btn" onClick={onClose}>Close</button>
        <button type="button" className="btn btn-primary" onClick={() => onCopyToForm(broadcast)}>
          <Icon name="copy" /> Salin ke form
        </button>
      </div>
    </div>
  );

  // Prompt 0161 — this whole read-only body is wrapped in a
  // <DataBotProvider value={broadcast.bot}> (see below) so
  // FormattedTelegramText/RichTextEditor/ButtonPreview resolve their own
  // premium-emoji botId from THIS broadcast's own bot, never an assumed
  // "active" one — self-contained, correct regardless of where this modal
  // gets rendered from.
  return (
    <DataBotProvider value={broadcast.bot}>
      <Modal title="View broadcast" onClose={onClose} className="view-broadcast-modal" footer={footer}>
        <div className="form-grid">
          <div className="field">
            <label>Title</label>
            <p className="view-broadcast-modal__static">
              <FormattedTelegramText text={broadcast.title} format={broadcast.titleFormat} />
            </p>
          </div>

          <div className="field">
            <label>Message</label>
            <RichTextEditor readOnly initialContent={bodyHtml} />
          </div>

          {(hasRealMedia || isLegacyMedia) && (
            <div className="field">
              <label>{broadcast.mediaType === 'video' ? 'Video' : 'Image'}</label>

              {hasRealMedia && media.status === 'loading' && (
                <div className="image-picker__placeholder">Loading preview…</div>
              )}

              {hasRealMedia && media.status === 'ready' && (
                broadcast.mediaType === 'video' ? (
                  // eslint-disable-next-line jsx-a11y/media-has-caption
                  <video src={media.objectUrl} controls className="view-broadcast-modal__media" />
                ) : (
                  <img src={media.objectUrl} alt="" className="view-broadcast-modal__media" />
                )
              )}

              {/* Fallback badge — a load failure for real media, or a legacy
                  mediaUrl broadcast, which was never fetchable this way (no
                  mediaFileId to resolve through Telegram at all). */}
              {((hasRealMedia && media.status === 'error') || isLegacyMedia) && (
                <>
                  <div className="image-picker__placeholder">
                    <Icon name={broadcast.mediaType === 'video' ? 'video' : 'image'} />{' '}
                    {broadcast.mediaType === 'video' ? 'Video attached (Telegram file)' : 'Image attached (Telegram file)'}
                  </div>
                  {hasRealMedia && media.status === 'error' && (
                    <p className="field-hint">Preview unavailable — {media.errorMessage}</p>
                  )}
                  {isLegacyMedia && (
                    <p className="field-hint">Media: {broadcast.mediaUrl} (legacy — not previewable here)</p>
                  )}
                </>
              )}
              {/* Prompt 0139 — separate from the preview fallback above: even
                  when the media previews fine here, "Salin ke form" may still
                  not be able to carry it into a new broadcast under the
                  CURRENT bot context. */}
              {mediaNote && <p className="field-hint">{mediaNote}</p>}
            </div>
          )}

          {buttons.length > 0 && (
            <div className="field">
              <label>Buttons</label>
              <div className="button-rows">
                {buttons.map((button, index) => (
                  <a
                    key={index}
                    href={button.url}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-sm"
                    style={{ alignSelf: 'flex-start' }}
                  >
                    <ButtonPreview text={button.text} iconCustomEmojiId={button.iconCustomEmojiId} />
                  </a>
                ))}
              </div>
            </div>
          )}

          <div className="form-row">
            <div className="field">
              <label>Target</label>
              <p className="view-broadcast-modal__static">
                {TARGET_TYPE_LABELS[broadcast.targetType]}
                {broadcast.targetChannelId ? ` — ${broadcast.targetChannelId}` : ''}
              </p>
            </div>
            <div className="field">
              <label>Status</label>
              <p className="view-broadcast-modal__static"><Badge value={broadcast.status} kind="broadcastStatus" /></p>
            </div>
          </div>

          <div className="field">
            <label>When</label>
            <p className="view-broadcast-modal__static">
              {broadcast.scheduledAt ? `Scheduled for ${formatDate(broadcast.scheduledAt)}` : `Created ${formatDate(broadcast.createdAt)}`}
            </p>
          </div>

          {broadcast.isRecurring && (
            <div className="field">
              <label>Recurring</label>
              <p className="view-broadcast-modal__recurring">{recurringProgressLabel(broadcast)}</p>
            </div>
          )}
        </div>
      </Modal>
    </DataBotProvider>
  );
}
