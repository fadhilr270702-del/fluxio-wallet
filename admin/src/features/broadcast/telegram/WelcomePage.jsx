import React, { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../../../components/Icon.jsx';
import Modal from '../../../components/Modal.jsx';
import BroadcastTabs from './BroadcastTabs.jsx';
import RichTextEditor from './RichTextEditor.jsx';
import WelcomeVersionViewModal from './WelcomeVersionViewModal.jsx';
import EmojiPickerButton from './EmojiPickerButton.jsx';
import ButtonPremiumIconControl from './ButtonPremiumIconControl.jsx';
import { insertAtCursor } from './cursorInsert.js';
import {
  editorJsonToTelegramHtml,
  validateEditorLinks,
  isEditorDocEmpty,
  bodyToEditorHtml,
  editorPlainTextLength
} from './editorTelegramFormat.js';
import { broadcastPlainTextExcerpt } from './composeRecentCards.js';
import { formatDate } from '../../../utils/formatDate.js';
import {
  getWelcomeMessage,
  updateWelcomeMessage,
  uploadWelcomeImage,
  uploadWelcomeVideo,
  fetchWelcomeImage,
  listWelcomeVersions,
  fetchWelcomeVersionMedia,
  copyWelcomeToOtherBot
} from '../../../services/welcomeApi.js';
import useBotContext from '../../../hooks/useBotContext.js';
import useBotSwitchGuard from '../../../hooks/useBotSwitchGuard.js';
import useBotSwitchSaveAction from '../../../hooks/useBotSwitchSaveAction.js';
import { BOT_CONTEXTS, otherBotId } from '../../../app/BotContext.jsx';
import { hasPremiumEmojiContent, shouldShowPremiumEmojiWarning } from './premiumEmojiWarning.js';
import { DataBotProvider } from '../../../app/DataBotContext.jsx';

// Same 1024 (with media) / 4096 (without) split as the backend's own
// captionLimitFor() (backend/src/telegram/formatting.js) — duplicated here
// rather than fetched from the server, matching this app's existing
// pattern of mirroring backend zod rules client-side for instant feedback
// (see ComposePage.jsx's own validateButtons comment) while the server
// remains the authoritative re-check either way. Already covers video with
// zero changes as of prompt 0137 — it was always "is any media attached",
// never specifically "is it an image".
function captionLimitFor(hasMedia) {
  return hasMedia ? 1024 : 4096;
}

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_VIDEO_TYPES = ['video/mp4'];
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/** Same shape/wording as ComposePage.jsx's own local validateButtons. */
function validateButtons(buttons) {
  for (let i = 0; i < buttons.length; i += 1) {
    const { text, url } = buttons[i];
    const label = `Button ${i + 1}`;
    if (!text.trim()) return `${label}: button text is required.`;
    if (!url.trim()) return `${label}: button URL is required.`;
    if (!url.trim().startsWith('https://')) return `${label}: button URL must start with https://`;
    try {
      // eslint-disable-next-line no-new
      new URL(url.trim());
    } catch {
      return `${label}: button URL must be a valid URL.`;
    }
  }
  return null;
}

/**
 * The admin-editable /start welcome message (prompt 0136, extended by 0137
 * with video support + version history) — a single-slot form, deliberately
 * styled like Compose (same RichTextEditor, same image/video-picker and
 * button-rows markup and behavior) but simpler: no title, no target
 * picker, no schedule — just body + one optional image OR video + buttons,
 * because there is exactly one welcome message, always active, never
 * "sent" in the broadcast sense. The missing title field is a deliberate,
 * permanent decision (prompt 0137's own explicit note): the rich text body
 * already covers what a title would add, and there is no list of welcome
 * messages that would ever need one to tell rows apart.
 *
 * Below the form, "Riwayat versi" (prompt 0137) lists every past Save as
 * its own permanent, independently-viewable snapshot — see
 * WelcomeVersionViewModal.jsx for the read-only "Lihat" view, and
 * handleLoadToForm() below for "Muat ke form", which only ever populates
 * the editor; the admin must still press Save to actually reactivate it
 * (deliberately not instant — see this prompt's own "restore TIDAK
 * langsung aktif" requirement), at which point it becomes a brand-new
 * version of its own, not a revert.
 */
export default function WelcomePage() {
  // Prompt 0139 — every read/write below is scoped to whichever bot the
  // sidebar switcher currently has active. Unlike Compose, Welcome's media
  // picker is NOT gated by bot context (see the base prompt's own explicit
  // "Tab Welcome TETAP penuh fungsinya" requirement) — welcome media is
  // real server-side storage per bot (welcome.js's saveUploadedMedia),
  // genuinely bot-agnostic, unlike the broadcast composer's file_id-based
  // upload, which IS hardcoded to 'test' (see ComposePage.jsx's own
  // mediaDisabledForBot comment for that contrast).
  const { botId } = useBotContext();
  const targetBotId = otherBotId(botId);
  const targetBotMeta = BOT_CONTEXTS[targetBotId];
  const sourceBotMeta = BOT_CONTEXTS[botId];
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  // "Salin ke bot lain" (prompt 0141) — a management action on the whole
  // CURRENTLY SAVED config, entirely separate from the form's own
  // Save/isDirty flow below (this never touches what's in the form; it
  // copies whatever's actually active for this bot right now, the same
  // thing a real /start would send).
  const [copyToOtherBotConfirm, setCopyToOtherBotConfirm] = useState(false);
  const [copyingToOtherBot, setCopyingToOtherBot] = useState(false);
  const [copyToOtherBotError, setCopyToOtherBotError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  const [editorKey, setEditorKey] = useState(0);
  const [initialBodyHtml, setInitialBodyHtml] = useState('');
  const [bodyDoc, setBodyDoc] = useState(null);
  const [imageFilename, setImageFilename] = useState(null);
  const [mediaType, setMediaType] = useState(null); // null | 'image' | 'video'
  const [buttons, setButtons] = useState([]);

  // Same media-preview state shape as ComposePage.jsx — mediaPreviewUrl is
  // either the currently-configured media's blob (fetched through the
  // authenticated /admin/welcome/media endpoint, same "never a bare static
  // URL" rule prompt 0132 Revision 2 set) or a freshly-picked local file's
  // own blob: URL, set optimistically before its upload even finishes.
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState(null);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [mediaError, setMediaError] = useState(null);
  const imageInputRef = useRef(null);
  const videoInputRef = useRef(null);
  const objectUrlRef = useRef(null);

  // Prompt 0147 — same insert-at-cursor + restore-caret-after-commit
  // pattern as ComposePage.jsx's own button-text rows (there is no Title
  // field on this page to mirror — see this file's own header comment on
  // why that's permanent, not a gap).
  const buttonTextInputRefs = useRef({});
  const [pendingButtonCaret, setPendingButtonCaret] = useState(null);

  // Prompt 0139 — explicit dirty tracking for the bot-switch guard. Unlike
  // Compose (whose create-mode form always STARTS blank, so "is it empty"
  // is a correct proxy for "has anything unsaved"), Welcome's form always
  // starts pre-populated with the real, already-saved config — an
  // isFormEmpty()-style check would treat that normal, unedited state as
  // "dirty" and confirm on EVERY switch, not just a genuine edit (caught by
  // this prompt's own live verification: switching bot on a freshly-loaded,
  // untouched Welcome tab showed the overwrite-confirm even though nothing
  // had been typed).
  //
  // Prompt 0142 — the original fix here was a `justLoadedRef` boolean
  // flipped back off by a `setTimeout(0)`, meant to suppress the one
  // mount-sync `handleBodyChange` call RichTextEditor pushes on every
  // mount (including the forced remount every bot-switch load triggers via
  // `editorKey`). That timer-based suppression was a genuine, reproducible
  // bug, not just a theoretical race: a live browser run of this exact
  // page showed the `setTimeout(0)` callback firing and clearing the flag
  // BEFORE RichTextEditor's own mount effect ever ran, so the "suppressed"
  // call arrived unsuppressed and marked a freshly-loaded, completely
  // untouched form as dirty every time — reintroducing the exact bug this
  // whole mechanism existed to prevent, just via a different trigger.
  // Replaced with a deterministic, non-timing-based signal instead: see
  // RichTextEditor.jsx's own `{ isInitialSync: true }` second argument,
  // checked directly in handleBodyChange below — no ref, no timer, no
  // window to race.
  const [isDirty, setIsDirty] = useState(false);

  const [versions, setVersions] = useState({ loading: true, error: null, items: [] });
  const [viewingVersion, setViewingVersion] = useState(null);
  const [loadConfirm, setLoadConfirm] = useState(null);

  function loadVersions() {
    setVersions((v) => ({ ...v, loading: true, error: null }));
    listWelcomeVersions({ bot: botId })
      .then(({ versions: items }) => setVersions({ loading: false, error: null, items }))
      .catch(() => setVersions({ loading: false, error: 'Could not load version history.', items: [] }));
  }

  // Prompt 0139 — re-runs whenever the switcher changes bot context, so
  // both the form and "Riwayat versi" always reflect whichever bot is
  // CURRENTLY selected — a fresh load, not a merge with whatever the other
  // bot's config happened to be. `editorKey` bumps on every re-run (not
  // just the first) so RichTextEditor remounts with this bot's own content
  // instead of keeping whatever HTML the previous bot's mount already
  // pushed into it (it only reads `initialContent` once, at mount — same
  // reasoning as resetFormAfterSend's own comment in ComposePage.jsx).
  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setLoadError(null);
    setSuccessMessage(null);
    setError(null);
    setMediaPreviewUrl(null); // don't show the OTHER bot's media while this one's own load is in flight
    setIsDirty(false); // a fresh load is never itself an unsaved edit
    getWelcomeMessage({ bot: botId })
      .then(({ welcome }) => {
        if (canceled) return;
        setInitialBodyHtml(bodyToEditorHtml(welcome.body, welcome.bodyFormat));
        setBodyDoc(null);
        setEditorKey((k) => k + 1);
        setImageFilename(welcome.imageFilename);
        setMediaType(welcome.mediaType);
        setButtons(welcome.buttons || []);
        if (welcome.imageFilename) {
          fetchWelcomeImage({ bot: botId })
            .then((blob) => {
              if (canceled) return;
              const url = URL.createObjectURL(blob);
              objectUrlRef.current = url;
              setMediaPreviewUrl(url);
            })
            .catch(() => {
              // Falls back to the "no preview, but a file is configured"
              // placeholder below — never a raw error UI, same as
              // ViewBroadcastModal's own media-fetch failure handling.
            });
        }
      })
      .catch(() => setLoadError('Could not load the welcome message.'))
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    loadVersions();
    return () => {
      canceled = true;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  // Registers this page's own "has the form actually been edited since it
  // loaded" check with the sidebar switcher's guard (see
  // useBotSwitchGuard.js) — see `isDirty`'s own comment above for why this
  // is explicit change-tracking, not an isFormEmpty()-style content check.
  useBotSwitchGuard(useCallback(() => isDirty, [isDirty]));

  function handleBodyChange(doc, meta) {
    setBodyDoc(doc);
    if (meta?.isInitialSync) return; // the one mount-sync push every RichTextEditor mount makes — never real user intent
    if (successMessage) setSuccessMessage(null);
    setIsDirty(true);
  }

  function clearMediaPreview() {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setMediaPreviewUrl(null);
    setMediaError(null);
    if (imageInputRef.current) imageInputRef.current.value = '';
    if (videoInputRef.current) videoInputRef.current.value = '';
  }

  async function handleFileSelected(e, type) {
    const file = e.target.files?.[0];
    if (!file) return;
    setMediaError(null);

    const allowedTypes = type === 'video' ? ALLOWED_VIDEO_TYPES : ALLOWED_IMAGE_TYPES;
    const maxBytes = type === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (!allowedTypes.includes(file.type)) {
      setMediaError(type === 'video' ? 'Only MP4 video is supported.' : 'Only JPG, PNG, and WEBP images are supported.');
      e.target.value = '';
      return;
    }
    if (file.size > maxBytes) {
      setMediaError(type === 'video' ? 'Video is too large — the limit is 50 MB.' : 'Image is too large — the limit is 10 MB.');
      e.target.value = '';
      return;
    }

    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const localPreview = URL.createObjectURL(file);
    objectUrlRef.current = localPreview;
    setMediaPreviewUrl(localPreview);
    setMediaType(type); // optimistic, before the upload even starts — flips the picker UI + disables the other slot right away
    setUploadingMedia(true);
    try {
      const uploadFn = type === 'video' ? uploadWelcomeVideo : uploadWelcomeImage;
      const { imageFilename: uploaded } = await uploadFn(file, { bot: botId });
      setImageFilename(uploaded);
      setIsDirty(true);
    } catch (err) {
      setMediaError(err.message || `Could not upload this ${type}.`);
      URL.revokeObjectURL(localPreview);
      objectUrlRef.current = null;
      setMediaPreviewUrl(null);
      setMediaType(null);
      e.target.value = '';
    } finally {
      setUploadingMedia(false);
    }
  }

  function handleRemoveMedia() {
    clearMediaPreview();
    setImageFilename(null);
    setMediaType(null);
    setIsDirty(true);
  }

  function addButtonRow() {
    setButtons((b) => [...b, { text: '', url: '' }]);
    setIsDirty(true);
  }
  function updateButtonRow(index, key, value) {
    setButtons((b) => b.map((btn, i) => (i === index ? { ...btn, [key]: value } : btn)));
    setIsDirty(true);
  }
  function removeButtonRow(index) {
    setButtons((b) => b.filter((_, i) => i !== index));
    setIsDirty(true);
  }

  // Prompt 0147 — inserts the picked emoji at that row's actual cursor
  // position, through the same updateButtonRow() path a manual edit uses
  // (so it marks dirty the same way). Caret restoration is deferred to the
  // effect below, run after the new value has actually committed — same
  // reasoning as ComposePage.jsx's own identical pair of functions.
  function handleButtonTextEmoji(index, emojiNative) {
    const input = buttonTextInputRefs.current[index];
    const currentValue = buttons[index]?.text || '';
    const { nextValue, nextCaret } = insertAtCursor(currentValue, input?.selectionStart, input?.selectionEnd, emojiNative);
    setPendingButtonCaret({ index, caret: nextCaret });
    updateButtonRow(index, 'text', nextValue);
  }

  useEffect(() => {
    if (!pendingButtonCaret) return;
    const { index, caret } = pendingButtonCaret;
    setPendingButtonCaret(null);
    const input = buttonTextInputRefs.current[index];
    if (input) {
      input.focus();
      input.setSelectionRange(caret, caret);
    }
  }, [pendingButtonCaret]);

  const hasMedia = Boolean(imageFilename);
  const imageAttached = mediaType === 'image';
  const videoAttached = mediaType === 'video';
  const charLimit = captionLimitFor(hasMedia);
  const charCount = bodyDoc ? editorPlainTextLength(bodyDoc) : 0;
  const overLimit = charCount > charLimit;
  // Prompt 0153 — Welcome has no channel concept at all (always a private
  // send to whoever started the bot), so shouldShowPremiumEmojiWarning's
  // own targetType check simply never applies here — omitted, not passed
  // as undefined explicitly, letting that function's own "only trial-bot
  // matters" degradation handle it.
  const showPremiumEmojiWarning = shouldShowPremiumEmojiWarning({
    hasPremiumContent: hasPremiumEmojiContent({ bodyDoc, buttons }),
    botId
  });

  // "Muat ke form" applies a version's content directly, without saving —
  // same replace-not-stack Modal pattern as ComposePage's own "Salin ke
  // form": guarded by an overwrite-confirm only when the form actually has
  // content, mirroring isComposeFormEmpty's own body-only check (Welcome
  // has no title to also check).
  function isFormEmpty() {
    return !bodyDoc || isEditorDocEmpty(bodyDoc);
  }

  function applyLoadToForm(version) {
    setInitialBodyHtml(bodyToEditorHtml(version.body, version.bodyFormat));
    setBodyDoc(null);
    setEditorKey((k) => k + 1); // force RichTextEditor to remount with the new initialContent — it only reads that prop once, at mount
    setImageFilename(version.imageFilename);
    setMediaType(version.mediaType);
    setButtons(version.buttons || []);
    setSuccessMessage(null);
    setError(null);
    setLoadConfirm(null);
    setViewingVersion(null);
    // Prompt 0139 — loading a historical version genuinely IS a change
    // away from whatever's currently saved (the admin still has to press
    // Save to persist it), so this marks dirty explicitly and directly —
    // it never relied on (and, as of prompt 0142, no longer even could
    // rely on) the remount's own mount-sync handleBodyChange call to do
    // it, since that call is now always treated as non-dirty-marking
    // regardless of which path triggered the remount (see
    // RichTextEditor.jsx's own `isInitialSync` comment).
    setIsDirty(true);

    clearMediaPreview();
    if (version.imageFilename) {
      fetchWelcomeVersionMedia(version.id)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          objectUrlRef.current = url;
          setMediaPreviewUrl(url);
        })
        .catch(() => {
          // Same graceful placeholder fallback as the initial-load fetch above.
        });
    }
  }

  function handleLoadToForm(version) {
    if (isFormEmpty()) {
      applyLoadToForm(version);
      return;
    }
    setViewingVersion(null);
    setLoadConfirm(version); // form has content — confirm the overwrite first
  }

  // Prompt 0142 — extracted out of handleSubmit so the bot-switch dialog's
  // own "Simpan dan beralih" (see useBotSwitchSaveAction below) can run the
  // exact same validated save path the Save button uses, not a
  // reimplementation of it. Never throws — always resolves {success,
  // error} — so BOTH callers (this form's own submit handler, and the
  // dialog) independently decide how to surface a failure in their own UI,
  // rather than this function reaching into either one's error state
  // directly. The success path's own side effects (successMessage,
  // isDirty, loadVersions) stay here rather than in either caller, since
  // they're true regardless of which path triggered the save.
  const performSave = useCallback(async () => {
    const buttonsError = validateButtons(buttons);
    if (buttonsError) return { success: false, error: buttonsError };

    if (!bodyDoc || isEditorDocEmpty(bodyDoc)) {
      return { success: false, error: 'Message is required.' };
    }
    const linkError = validateEditorLinks(bodyDoc);
    if (linkError) return { success: false, error: linkError };
    if (overLimit) {
      return {
        success: false,
        error: hasMedia
          ? `With media attached, the message must be at most ${charLimit} characters — remove the media or shorten the text.`
          : `The message must be at most ${charLimit} characters.`
      };
    }
    if (uploadingMedia) {
      return { success: false, error: 'Wait for the media to finish uploading before saving.' };
    }

    const body = editorJsonToTelegramHtml(bodyDoc);
    // iconCustomEmojiId (prompt 0153) — same fix as ComposePage's own
    // equivalent mapping, which had the identical gap.
    const cleanButtons = buttons.map((b) => ({ text: b.text.trim(), url: b.url.trim(), iconCustomEmojiId: b.iconCustomEmojiId || null }));

    try {
      await updateWelcomeMessage({ bot: botId, body, bodyFormat: 'html', imageFilename, buttons: cleanButtons });
      setSuccessMessage('Welcome message saved.');
      setIsDirty(false); // just persisted — the switcher's guard shouldn't fire for content that's now saved
      loadVersions(); // the save above just appended a new version — refresh the history list to show it immediately
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message || 'Could not save the welcome message.' };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buttons, bodyDoc, overLimit, hasMedia, charLimit, uploadingMedia, botId, imageFilename]);

  // Registers this exact save path with the bot-switch dialog — see
  // BotContext.jsx's own registerSwitchSaveAction comment for why Compose
  // never makes an equivalent call (a broadcast draft has no storage of
  // its own).
  useBotSwitchSaveAction(performSave, 'Welcome');

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccessMessage(null);
    const result = await performSave();
    if (!result.success) setError(result.error);
    setSubmitting(false);
  }

  // "Salin ke bot lain" — direction is always THIS bot -> the other one
  // (see BotContext.jsx's own otherBotId()); copies the real active
  // config, not whatever's currently sitting unsaved in the form above.
  // Official as the TARGET needs no send-guard-style confirmation (this is
  // configuration, never a send — see the base prompt's own explicit
  // "Mode resmi sebagai TARGET tidak butuh pagar ekstra" instruction), but
  // the confirm modal below still names both bots plainly either way.
  async function handleConfirmCopyToOtherBot() {
    setCopyingToOtherBot(true);
    setCopyToOtherBotError(null);
    try {
      await copyWelcomeToOtherBot({ bot: botId });
      setCopyToOtherBotConfirm(false);
      setSuccessMessage(`Copied to ${targetBotMeta.label}.`);
    } catch (err) {
      setCopyToOtherBotError(err.message || 'Could not copy to the other bot.');
    } finally {
      setCopyingToOtherBot(false);
    }
  }

  if (loading) return <div className="loading-state">Loading…</div>;

  // Prompt 0161 — the whole page wrapped in <DataBotProvider value={botId}>
  // using the plain ACTIVE bot from useBotContext(), not an edit-mode-aware
  // value: unlike ComposePage, Welcome has no separate "existing record's
  // own bot" to diverge from — there is exactly one welcome message per
  // bot, and this whole page already reloads from scratch on every switcher
  // change (see the load effect's own [botId] dependency above), so the
  // active bot IS this page's data-owner bot at all times.
  return (
    <DataBotProvider value={botId}>
    <main>
      <div className="page-head">
        <div>
          <h1>Broadcast — Telegram</h1>
          <p className="page-head__desc">
            Sent once, automatically, the moment someone starts the bot — not a broadcast, always active.
          </p>
        </div>
        <div>
          <button type="button" className="btn btn-sm" onClick={() => setCopyToOtherBotConfirm(true)}>
            <Icon name="copy" /> Salin ke {targetBotMeta.label}
          </button>
        </div>
      </div>

      <BroadcastTabs />

      {loadError && <div className="form-error" style={{ marginBottom: 16 }}>{loadError}</div>}
      {!loadError && successMessage && <div className="form-success" style={{ marginBottom: 16 }}>{successMessage}</div>}

      {!loadError && (
        <div className="card form-card">
          <form className="form-grid" onSubmit={handleSubmit}>
            {error && <div className="form-error">{error}</div>}

            <div className="field">
              <label>Message</label>
              <RichTextEditor key={editorKey} initialContent={initialBodyHtml} onChange={handleBodyChange} />
              <span className={`field-hint${overLimit ? ' field-hint--error' : ''}`}>
                {charCount}/{charLimit} characters {hasMedia ? '(media attached — lower limit)' : ''}
              </span>
            </div>

            <div className="field">
              <label>Image (optional)</label>
              <div className="image-picker">
                {imageAttached && mediaPreviewUrl ? (
                  <img src={mediaPreviewUrl} alt="" className="image-picker__preview" />
                ) : (
                  imageAttached && imageFilename && (
                    <div className="image-picker__placeholder">
                      <Icon name="image" /> Image configured
                    </div>
                  )
                )}
                <div className="image-picker__actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => imageInputRef.current?.click()}
                    disabled={uploadingMedia || videoAttached}
                  >
                    <Icon name="image" /> {imageAttached ? 'Replace' : 'Choose image'}
                  </button>
                  {imageAttached && (
                    <button type="button" className="btn btn-sm btn-danger" onClick={handleRemoveMedia} disabled={uploadingMedia}>
                      Remove
                    </button>
                  )}
                </div>
                {videoAttached && (
                  <span className="image-picker__disabled-note">Remove the attached video to add an image instead.</span>
                )}
              </div>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                style={{ display: 'none' }}
                onChange={(e) => handleFileSelected(e, 'image')}
              />
              {mediaError && imageAttached && <div className="form-error">{mediaError}</div>}
              {uploadingMedia && imageAttached && <span className="field-hint">Uploading…</span>}
              <span className="field-hint">JPG, PNG, or WEBP, up to 10 MB. One image OR one video, not both.</span>
            </div>

            <div className="field">
              <label>Video (optional)</label>
              <div className="image-picker">
                {videoAttached && mediaPreviewUrl ? (
                  // eslint-disable-next-line jsx-a11y/media-has-caption
                  <video src={mediaPreviewUrl} controls className="view-broadcast-modal__media" />
                ) : (
                  videoAttached && imageFilename && (
                    <div className="image-picker__placeholder">
                      <Icon name="video" /> Video configured
                    </div>
                  )
                )}
                <div className="image-picker__actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => videoInputRef.current?.click()}
                    disabled={uploadingMedia || imageAttached}
                  >
                    <Icon name="image" /> {videoAttached ? 'Replace' : 'Choose video'}
                  </button>
                  {videoAttached && (
                    <button type="button" className="btn btn-sm btn-danger" onClick={handleRemoveMedia} disabled={uploadingMedia}>
                      Remove
                    </button>
                  )}
                </div>
                {imageAttached && (
                  <span className="image-picker__disabled-note">Remove the attached image to add a video instead.</span>
                )}
              </div>
              <input
                ref={videoInputRef}
                type="file"
                accept="video/mp4"
                style={{ display: 'none' }}
                onChange={(e) => handleFileSelected(e, 'video')}
              />
              {mediaError && videoAttached && <div className="form-error">{mediaError}</div>}
              {uploadingMedia && videoAttached && (
                <span className="field-hint">Uploading video… larger files can take a moment, this isn't stuck.</span>
              )}
              <span className="field-hint">MP4 only, up to 50 MB.</span>
            </div>

            <div className="field">
              <label>Buttons (optional)</label>
              <div className="button-rows">
                {buttons.map((button, index) => (
                  <div className="button-rows__row" key={index}>
                    <div className="field">
                      <div className="input-with-emoji">
                        <input
                          ref={(el) => { buttonTextInputRefs.current[index] = el; }}
                          aria-label={`Button ${index + 1} text`}
                          placeholder="Button text"
                          value={button.text}
                          maxLength={64}
                          onChange={(e) => updateButtonRow(index, 'text', e.target.value)}
                        />
                        <EmojiPickerButton
                          ariaLabel={`Insert emoji into button ${index + 1} text`}
                          onSelect={(emojiNative) => handleButtonTextEmoji(index, emojiNative)}
                        />
                      </div>
                    </div>
                    <div className="field">
                      <input
                        aria-label={`Button ${index + 1} URL`}
                        type="url"
                        placeholder="https://…"
                        value={button.url}
                        onChange={(e) => updateButtonRow(index, 'url', e.target.value)}
                      />
                    </div>
                    <ButtonPremiumIconControl
                      iconCustomEmojiId={button.iconCustomEmojiId}
                      onSelect={(customEmojiId) => updateButtonRow(index, 'iconCustomEmojiId', customEmojiId)}
                      onRemove={() => updateButtonRow(index, 'iconCustomEmojiId', null)}
                      ariaLabelPrefix={`Button ${index + 1}`}
                    />
                    <button
                      type="button"
                      className="icon-btn button-rows__remove"
                      onClick={() => removeButtonRow(index)}
                      aria-label={`Remove button ${index + 1}`}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" className="btn btn-sm button-rows__add" onClick={addButtonRow}>
                <Icon name="plus" /> Add button
              </button>
              <span className="field-hint">
                Shown under the message as clickable Telegram buttons. URLs must start with https://.
              </span>
            </div>

            {showPremiumEmojiWarning && (
              <p className="field-hint field-hint--warning">
                Emoji premium dan ikon tombol premium akan tampil sebagai emoji biasa atau tanpa ikon di target ini.
              </p>
            )}

            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={submitting || uploadingMedia}>
                <Icon name="send" /> {submitting ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="recent-broadcasts">
        <h2 className="recent-broadcasts__heading">Riwayat versi</h2>
        {versions.loading && <div className="loading-state">Loading…</div>}
        {versions.error && <div className="form-error">{versions.error}</div>}
        {!versions.loading && !versions.error && versions.items.length === 0 && (
          <div className="data-table__empty">No saved versions yet — your first Save will show up here.</div>
        )}
        {!versions.loading && !versions.error && versions.items.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Saved</th>
                  <th>Editor</th>
                  <th>Message</th>
                  <th>Media</th>
                  <th>Buttons</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {versions.items.map((v) => (
                  <tr key={v.id}>
                    <td className="data-table__meta">{formatDate(v.createdAt)}</td>
                    <td className="data-table__meta">{v.updatedByEmail || '—'}</td>
                    <td>{broadcastPlainTextExcerpt(v, 80)}</td>
                    <td>
                      {v.mediaType && (
                        <span className="recent-broadcast-card__badge">
                          <Icon name={v.mediaType === 'video' ? 'video' : 'image'} /> {v.mediaType === 'video' ? 'Video' : 'Image'}
                        </span>
                      )}
                    </td>
                    <td className="data-table__meta">{(v.buttons || []).length}</td>
                    <td>
                      <div className="data-table__actions">
                        <button type="button" className="btn btn-sm" onClick={() => setViewingVersion(v)}>View</button>
                        <button type="button" className="btn btn-sm" onClick={() => handleLoadToForm(v)}>
                          <Icon name="copy" /> Muat ke form
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {viewingVersion && (
        <WelcomeVersionViewModal
          version={viewingVersion}
          onClose={() => setViewingVersion(null)}
          onLoadToForm={handleLoadToForm}
        />
      )}

      {loadConfirm && (
        <Modal title="Timpa isi form saat ini?" onClose={() => setLoadConfirm(null)}>
          <p>
            Form masih berisi konten yang belum disimpan. Memuat versi dari {formatDate(loadConfirm.createdAt)} akan
            menimpanya.
          </p>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setLoadConfirm(null)}>Batal</button>
            <button type="button" className="btn btn-primary" onClick={() => applyLoadToForm(loadConfirm)}>
              Timpa dan muat
            </button>
          </div>
        </Modal>
      )}

      {copyToOtherBotConfirm && (
        <Modal
          title={`Salin welcome ke ${targetBotMeta.label}?`}
          onClose={() => (copyingToOtherBot ? null : setCopyToOtherBotConfirm(false))}
        >
          {copyToOtherBotError && <div className="form-error" style={{ marginBottom: 16 }}>{copyToOtherBotError}</div>}
          <p>
            Konfigurasi welcome {sourceBotMeta.label} saat ini (pesan, tombol, dan media) akan disalin ke{' '}
            {targetBotMeta.label}, menimpa konfigurasi {targetBotMeta.label} yang ada. Ini langsung tersimpan sebagai
            versi baru di {targetBotMeta.label} — bukan cuma dimuat ke form.
          </p>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setCopyToOtherBotConfirm(false)} disabled={copyingToOtherBot}>
              Batal
            </button>
            <button type="button" className="btn btn-primary" onClick={handleConfirmCopyToOtherBot} disabled={copyingToOtherBot}>
              {copyingToOtherBot ? 'Menyalin…' : `Salin ke ${targetBotMeta.label}`}
            </button>
          </div>
        </Modal>
      )}
    </main>
    </DataBotProvider>
  );
}
