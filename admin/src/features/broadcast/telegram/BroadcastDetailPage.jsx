import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Badge from '../../../components/Badge.jsx';
import Modal from '../../../components/Modal.jsx';
import { formatDate } from '../../../utils/formatDate.js';
import { getTelegramBroadcast, cancelTelegramBroadcast, deactivateRecurringBroadcast } from '../../../services/telegramBroadcastApi.js';
import { TARGET_TYPE_LABELS, progressLabel, recurringProgressLabel } from './telegramBroadcastStatus.js';
import { titlePlainText } from './composeRecentCards.js';
import FormattedTelegramText from './FormattedTelegramText.jsx';
import ButtonPreview from './ButtonPreview.jsx';
import RichTextEditor from './RichTextEditor.jsx';
import { bodyToEditorHtml } from './editorTelegramFormat.js';
import { DataBotProvider } from '../../../app/DataBotContext.jsx';

export default function BroadcastDetailPage() {
  const { id } = useParams();
  const [broadcast, setBroadcast] = useState(null);
  const [failedRecipients, setFailedRecipients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Prompt 0134 — the deactivate confirmation uses Modal.jsx (per that
  // prompt's own explicit instruction), unlike this page's existing Cancel
  // action just above, which already used a plain window.confirm() before
  // this feature existed — left as-is, not retrofitted, since only the new
  // action was asked to use Modal.
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);
  const [deactivating, setDeactivating] = useState(false);

  const load = useCallback(() => {
    getTelegramBroadcast(id)
      .then((data) => {
        setBroadcast(data.broadcast);
        setFailedRecipients(data.failedRecipients);
      })
      .catch(() => setError('Could not load this broadcast.'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCancel() {
    if (!window.confirm('Cancel this scheduled broadcast? It will not be sent.')) return;
    setError(null);
    try {
      await cancelTelegramBroadcast(id);
      load();
    } catch (err) {
      // Most likely the worker just activated it in the meantime — re-fetch
      // so the page reflects its real current status.
      setError(err.message || 'Could not cancel this broadcast.');
      load();
    }
  }

  async function handleConfirmDeactivate() {
    setDeactivating(true);
    setError(null);
    try {
      await deactivateRecurringBroadcast(id);
      setConfirmingDeactivate(false);
      load();
    } catch (err) {
      setError(err.message || 'Could not deactivate this recurring broadcast.');
    } finally {
      setDeactivating(false);
    }
  }

  if (loading) return <div className="loading-state">Loading…</div>;
  if (error && !broadcast) return <div className="form-error">{error}</div>;
  if (!broadcast) return null;

  // Prompt 0150 — same rendering pipeline ViewBroadcastModal already uses
  // for its own read-only Message field (bodyToEditorHtml() + RichTextEditor
  // readOnly), rather than a second HTML-to-DOM renderer: 'html' bodies
  // parse through the schema-restricted TipTap parser (no literal tags, no
  // dangerouslySetInnerHTML), 'plain' legacy bodies are HTML-escaped first
  // so a literal `<`/`>`/`&` still shows as typed, and both keep newlines as
  // separate paragraphs. See .broadcast-detail__body in admin.css for why
  // this still doesn't look like a boxed editor here despite reusing the
  // same component.
  const bodyHtml = bodyToEditorHtml(broadcast.body, broadcast.bodyFormat);

  // Prompt 0161 — the whole page wrapped in <DataBotProvider
  // value={broadcast.bot}> so every premium-emoji-resolving component
  // below reads THIS broadcast's own bot, never an assumed active one —
  // self-contained, correct regardless of which bot the switcher happens
  // to be pointed at when this page is opened via a direct link.
  return (
    <DataBotProvider value={broadcast.bot}>
    <main>
      <div className="page-head">
        <div>
          <h1><FormattedTelegramText text={broadcast.title} format={broadcast.titleFormat} /></h1>
          <p className="page-head__desc">
            <Link to="/broadcast/history" className="broadcast-detail__back-link">&larr; Back to history</Link>
          </p>
        </div>
        {broadcast.status === 'scheduled' && (
          <button className="btn btn-danger" onClick={handleCancel}>Cancel broadcast</button>
        )}
        {broadcast.status === 'recurring' && (
          <button className="btn btn-danger" onClick={() => setConfirmingDeactivate(true)}>Deactivate</button>
        )}
      </div>

      {error && <div className="form-error" style={{ marginBottom: 16 }}>{error}</div>}

      {confirmingDeactivate && (
        <Modal
          title="Deactivate recurring broadcast?"
          onClose={() => {
            if (!deactivating) setConfirmingDeactivate(false);
          }}
        >
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
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="stat-row">
          <div className="stat-tile">
            <div><span className="stat-tile__label">Status</span><span className="stat-tile__value"><Badge value={broadcast.status} /></span></div>
          </div>
          <div className="stat-tile">
            <div><span className="stat-tile__label">Target</span><span className="stat-tile__value">{TARGET_TYPE_LABELS[broadcast.targetType]}</span></div>
            {broadcast.targetChannelId && <span className="stat-tile__hint">{broadcast.targetChannelId}</span>}
          </div>
          {/* Prompt 0134 — a recurring broadcast's own sent_count means
              "successful rounds", not "recipients reached" (see the
              migration's own comment on this deliberate dual meaning), so
              it gets its own tile with its own wording instead of reusing
              the ordinary Delivery tile's "N sent / N failed" framing,
              which would otherwise misleadingly imply per-recipient counts. */}
          {broadcast.isRecurring ? (
            <div className="stat-tile">
              <div>
                <span className="stat-tile__label">Recurring</span>
                <span className="stat-tile__value view-broadcast-modal__recurring">{recurringProgressLabel(broadcast)}</span>
              </div>
            </div>
          ) : (
            <div className="stat-tile">
              <div>
                <span className="stat-tile__label">Delivery</span>
                <span className="stat-tile__value">{broadcast.sentCount} sent / {broadcast.failedCount} failed</span>
                <span className="stat-tile__hint">{progressLabel(broadcast) || `of ${broadcast.totalCount} total`}</span>
              </div>
            </div>
          )}
          {broadcast.scheduledAt && (
            <div className="stat-tile">
              <div><span className="stat-tile__label">Scheduled for</span><span className="stat-tile__value">{formatDate(broadcast.scheduledAt)}</span></div>
            </div>
          )}
        </div>
        <div className="broadcast-detail__body" style={{ marginTop: 16 }}>
          <RichTextEditor readOnly initialContent={bodyHtml} />
        </div>
        {broadcast.mediaUrl && <p className="field-hint">Media: {broadcast.mediaUrl}</p>}
        {broadcast.mediaFileId && (
          <p className="field-hint">
            {broadcast.mediaType === 'video' ? 'Video attached (Telegram file)' : 'Image attached (Telegram file)'}
          </p>
        )}
        {broadcast.buttons && broadcast.buttons.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <span className="field-hint">Buttons:</span>
            <div className="button-rows" style={{ marginTop: 6 }}>
              {broadcast.buttons.map((button, index) => (
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
        {broadcast.errorMessage && <div className="form-error" style={{ marginTop: 12 }}>{broadcast.errorMessage}</div>}
        <p className="data-table__meta" style={{ marginTop: 12 }}>Created {formatDate(broadcast.createdAt)} · Updated {formatDate(broadcast.updatedAt)}</p>
      </div>

      {broadcast.targetType === 'subscribers' && (
        <>
          <h2 style={{ fontSize: 'var(--step-1)', marginBottom: 12 }}>Failed recipients</h2>
          {failedRecipients.length === 0 ? (
            <div className="table-wrap"><div className="data-table__empty">No failures.</div></div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>Chat ID</th><th>Error</th><th>When</th></tr>
                </thead>
                <tbody>
                  {failedRecipients.map((r) => (
                    <tr key={r.id}>
                      <td>{r.chatId}</td>
                      <td>{r.errorMessage}</td>
                      <td className="data-table__meta">{formatDate(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
    </DataBotProvider>
  );
}
