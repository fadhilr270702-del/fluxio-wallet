import React, { useEffect, useState } from 'react';
import Modal from '../../../components/Modal.jsx';
import Icon from '../../../components/Icon.jsx';
import RichTextEditor from './RichTextEditor.jsx';
import { formatDate } from '../../../utils/formatDate.js';
import { bodyToEditorHtml } from './editorTelegramFormat.js';
import { fetchWelcomeVersionMedia } from '../../../services/welcomeApi.js';
import ButtonPreview from './ButtonPreview.jsx';

/**
 * Read-only "Lihat" (View) for one row of the Welcome tab's own version
 * history (prompt 0137) — mirrors ViewBroadcastModal.jsx's own pattern
 * (same body-through-RichTextEditor-readOnly rendering, same authenticated
 * blob-fetch-then-<img>/<video> media pattern) but with no title/target/
 * schedule/status fields, since a welcome version has none of those — just
 * the message, its media, its buttons, and who/when saved it.
 *
 * This is also the modal that proves prompt 0137's own single-slot fix
 * actually works: it fetches media through
 * GET /admin/welcome/versions/:id/media — a SPECIFIC version's own file,
 * never the currently-active one (see fetchWelcomeVersionMedia's own
 * comment) — so an old version keeps showing exactly what was attached
 * back when it was saved, even after several newer saves have replaced the
 * active config's own media entirely.
 *
 * Prompt 0155 — `botId` (for resolving premium-emoji assets in the body and
 * any button icons) comes from the page's own currently-selected bot, not
 * from `version` itself: `toVersionApiShape()` (welcomeController.js) never
 * includes a bot id on a version row, since `GET /admin/welcome/versions`
 * is always called scoped to one bot already — every version in the list
 * this modal could ever be opened from already belongs to that same bot.
 * This is a different situation from 0153's own botId-not-threaded bug
 * (there, the prop was simply never passed at all, for any bot); here,
 * there is no per-version bot field to read in the first place, so the
 * page's own bot context is the correct and only available source.
 *
 * Prompt 0161 — no longer takes an explicit `botId` prop at all: this
 * modal is always rendered from within `WelcomePage.jsx`'s own JSX return,
 * which now installs `<DataBotProvider value={<active bot>}>` around its
 * entire `<main>` — the exact "page's own bot context" this modal's own
 * 0155 comment above already identified as the correct source, just read
 * via context now instead of manually re-passed down as one more prop.
 * `RichTextEditor`/`ButtonPreview` below both resolve it themselves.
 */
export default function WelcomeVersionViewModal({ version, onClose, onLoadToForm }) {
  const bodyHtml = bodyToEditorHtml(version.body, version.bodyFormat);
  const buttons = version.buttons || [];
  const hasMedia = Boolean(version.imageFilename);

  // 'idle' (no media to fetch) | 'loading' | 'ready' | 'error'.
  const [media, setMedia] = useState({ status: hasMedia ? 'loading' : 'idle', objectUrl: null, errorMessage: null });

  useEffect(() => {
    if (!hasMedia) return undefined;
    let canceled = false;
    let objectUrl = null;
    setMedia({ status: 'loading', objectUrl: null, errorMessage: null });
    fetchWelcomeVersionMedia(version.id)
      .then((blob) => {
        if (canceled) return;
        objectUrl = URL.createObjectURL(blob);
        setMedia({ status: 'ready', objectUrl, errorMessage: null });
      })
      .catch((err) => {
        if (canceled) return;
        setMedia({ status: 'error', objectUrl: null, errorMessage: err.message || 'Could not load this version\'s media.' });
      });
    return () => {
      canceled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version.id, hasMedia]);

  const footer = (
    <div className="view-broadcast-modal__actions">
      <span />
      <div className="view-broadcast-modal__actions-right">
        <button type="button" className="btn" onClick={onClose}>Close</button>
        <button type="button" className="btn btn-primary" onClick={() => onLoadToForm(version)}>
          <Icon name="copy" /> Muat ke form
        </button>
      </div>
    </div>
  );

  return (
    <Modal title="Welcome version" onClose={onClose} className="view-broadcast-modal" footer={footer}>
      <div className="form-grid">
        <div className="field">
          <label>Message</label>
          <RichTextEditor readOnly initialContent={bodyHtml} />
        </div>

        {hasMedia && (
          <div className="field">
            <label>{version.mediaType === 'video' ? 'Video' : 'Image'}</label>

            {media.status === 'loading' && <div className="image-picker__placeholder">Loading preview…</div>}

            {media.status === 'ready' && (
              version.mediaType === 'video' ? (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video src={media.objectUrl} controls className="view-broadcast-modal__media" />
              ) : (
                <img src={media.objectUrl} alt="" className="view-broadcast-modal__media" />
              )
            )}

            {media.status === 'error' && (
              <>
                <div className="image-picker__placeholder">
                  <Icon name={version.mediaType === 'video' ? 'video' : 'image'} />{' '}
                  {version.mediaType === 'video' ? 'Video no longer available' : 'Image no longer available'}
                </div>
                <p className="field-hint">{media.errorMessage}</p>
              </>
            )}
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

        <div className="field">
          <label>Saved</label>
          <p className="view-broadcast-modal__static">
            {formatDate(version.createdAt)}{version.updatedByEmail ? ` — ${version.updatedByEmail}` : ''}
          </p>
        </div>
      </div>
    </Modal>
  );
}
