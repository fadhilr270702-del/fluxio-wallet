import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Icon from '../../../components/Icon.jsx';
import Modal from '../../../components/Modal.jsx';
import BroadcastTabs from './BroadcastTabs.jsx';
import {
  getTelegramStatus,
  createTelegramBroadcast,
  getTelegramBroadcast,
  listTelegramBroadcasts,
  updateTelegramBroadcastContent,
  uploadTelegramBroadcastImage,
  uploadTelegramBroadcastVideo
} from '../../../services/telegramBroadcastApi.js';
import { formatDate } from '../../../utils/formatDate.js';
import ScheduleFields from './ScheduleFields.jsx';
import { resolveScheduledAtIso } from './scheduleTimeHelpers.js';
import RichTextEditor from './RichTextEditor.jsx';
import RecentBroadcastCards from './RecentBroadcastCards.jsx';
import ViewBroadcastModal from './ViewBroadcastModal.jsx';
import EmojiPickerButton from './EmojiPickerButton.jsx';
import ButtonPremiumIconControl from './ButtonPremiumIconControl.jsx';
import { insertAtCursor } from './cursorInsert.js';
import {
  editorJsonToTelegramHtml,
  editorJsonToTelegramTitleHtml,
  validateEditorLinks,
  isEditorDocEmpty,
  isEditorTitleEmpty,
  bodyToEditorHtml,
  titleToEditorHtml,
  editorPlainTextLength
} from './editorTelegramFormat.js';
import { EMPTY_COMPOSE_FIELDS, isComposeFormEmpty, broadcastToComposeFields, titlePlainText } from './composeRecentCards.js';
import { isSendGuardRequired, buildSendGuardMessage } from './sendGuard.js';
import { hasPremiumEmojiContent, shouldShowPremiumEmojiWarning } from './premiumEmojiWarning.js';
import useBotContext from '../../../hooks/useBotContext.js';
import useBotSwitchGuard from '../../../hooks/useBotSwitchGuard.js';
import { DataBotProvider } from '../../../app/DataBotContext.jsx';

const EMPTY = EMPTY_COMPOSE_FIELDS;

const MAX_CAPTION_LENGTH = 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_VIDEO_TYPES = ['video/mp4'];

/**
 * Mirrors the backend's zod rules (adminTelegramBroadcastRoutes.js) so an
 * admin gets an immediate, clear error instead of waiting on a round trip —
 * the backend re-validates authoritatively either way, since Telegram
 * rejects the whole message over one bad button URL.
 */
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

export default function ComposePage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  // Prompt 0139 — every read/write below is scoped to `botId` (create mode)
  // or `existingBotId` (edit mode, the broadcast's OWN bot — see the
  // edit-mode fetch effect below; deliberately NOT the switcher's current
  // position, matching 0138's own "derive bot from the existing row" rule).
  const { botId, botMeta } = useBotContext();
  const [fields, setFields] = useState(EMPTY);
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  // Only ever set in edit mode, from the fetched broadcast's own `bot`
  // field — see buildMediaDisabled's own comment for why edit mode's media
  // gate uses this instead of the live switcher position.
  const [existingBotId, setExistingBotId] = useState(null);
  // Holds a fully-built, already-validated create payload awaiting explicit
  // confirmation (prompt 0139's send guard) — null means no confirmation is
  // pending. Only ever set for a create-mode submission while the official
  // bot is active (see isSendGuardRequired()).
  const [pendingSend, setPendingSend] = useState(null);

  // Rich-text message state: initialBodyHtml only ever seeds RichTextEditor
  // once (edit mode's fetched broadcast, converted via bodyToEditorHtml —
  // handles both old 'plain' and new 'html' rows); bodyDoc is the editor's
  // live TipTap JSON doc, kept in sync via its onChange, and is what
  // actually gets converted+validated at submit time.
  const [initialBodyHtml, setInitialBodyHtml] = useState('');
  const [bodyDoc, setBodyDoc] = useState(null);

  // Prompt 0149 — Title is now a RichTextEditor (singleLine mode) too,
  // exactly parallel to Message's own initialBodyHtml/bodyDoc pair above —
  // initialTitleHtml seeds it once (via titleToEditorHtml, handling both
  // legacy 'plain' and 'html' titles); titleDoc is the live doc, kept in
  // sync via its own onChange.
  const [initialTitleHtml, setInitialTitleHtml] = useState('');
  const [titleDoc, setTitleDoc] = useState(null);

  // Media picker state — shared by both the Image and Video sections
  // (video-upload slice), not a parallel pair of state groups, since only
  // one medium is ever attached at once (fields.mediaType says which).
  // mediaPreviewUrl is either a local blob: URL (a freshly-selected file,
  // via URL.createObjectURL — set the instant a file is picked, before the
  // upload even starts) or a legacy broadcast's real mediaUrl (image only,
  // directly renderable) — objectUrlRef tracks which, so it can be revoked
  // correctly without leaking memory. A broadcast that only has a
  // mediaFileId (no cheap way to render actual pixels/frames for a bare
  // file_id) shows a plain "attached" placeholder instead.
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState(null);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [mediaError, setMediaError] = useState(null);
  const imageInputRef = useRef(null);
  const videoInputRef = useRef(null);
  const objectUrlRef = useRef(null);
  // Prompt 0149 — Title is a RichTextEditor now, not a plain <input>; this
  // wraps its own .field container so the post-"Salin ke form" scroll+focus
  // effect below can reach the actual .ProseMirror DOM node inside it
  // (RichTextEditor exposes no imperative focus API of its own — reaching
  // through the wrapper avoids adding one just for this single use).
  const titleFieldRef = useRef(null);

  // Prompt 0147 — emoji-picker insertion for every button-row's own
  // "Button text" plain <input> (Title itself moved to RichTextEditor in
  // prompt 0149, which gets emoji insertion for free via its own toolbar —
  // see handleTitleEmoji's old comment history for what this used to also
  // cover). A controlled input's value update doesn't take effect in the
  // DOM until React re-renders, so the caret can't be restored
  // synchronously right after calling updateButtonRow() — instead the
  // pending-caret state below is read by an effect that runs AFTER the
  // corresponding value has actually committed, the same "wait for the
  // real signal, don't race a timer" principle prompt 0146 already
  // established for RichTextEditor's own isInitialSync fix.
  const buttonTextInputRefs = useRef({});
  const [pendingButtonCaret, setPendingButtonCaret] = useState(null);

  // Edit-mode-only: loading the existing broadcast, and whether it's still
  // actually editable (client-side courtesy check — the backend's atomic
  // update is what's authoritative if the status changes after this loads).
  const [loading, setLoading] = useState(isEdit);
  const [loadError, setLoadError] = useState(null);
  const [existingScheduledAt, setExistingScheduledAt] = useState(null);
  const [existingIsRecurring, setExistingIsRecurring] = useState(false);
  // Prompt 0164 — so the edit-mode hint text below can name the real
  // interval instead of a hardcoded "every hour" (no longer accurate now
  // that interval is per-broadcast).
  const [existingRecurringIntervalHours, setExistingRecurringIntervalHours] = useState(1);

  // Prompt 0132: create-mode-only additions. `editorKey` forces a fresh
  // RichTextEditor mount — it reads `initialContent` once at mount only
  // (see that file's own comment), so both "clear after a successful send"
  // and "prefill via Salin ke form" need a remount, not a state update, to
  // actually change what's displayed. `successMessage` replaces the old
  // navigate-to-history-on-send behavior in create mode; `recent` backs the
  // "Broadcast terakhir" cards; `copyConfirm` holds the broadcast pending
  // an overwrite confirmation (Modal) when the form isn't empty.
  const [editorKey, setEditorKey] = useState(0);
  const [successMessage, setSuccessMessage] = useState(null);
  // Prompt 0234 (P1) — the admin's explicit choice to replace the active
  // recurring broadcast instead of being blocked by the 409.
  const [replaceActive, setReplaceActive] = useState(false);
  const [recent, setRecent] = useState({ loading: !isEdit, error: null, items: [] });
  const [copyConfirm, setCopyConfirm] = useState(null);
  const [scrollFocusPending, setScrollFocusPending] = useState(false);
  // Revision 1: the broadcast currently open in the read-only "View" modal.
  const [viewBroadcast, setViewBroadcast] = useState(null);

  // Extracted so it can also be called after activating/deactivating a
  // recurring broadcast (prompt 0134) — the Compose guard notice/disabled
  // Send button needs to reflect that change immediately, not just on the
  // next full page load.
  function refreshStatus() {
    getTelegramStatus({ bot: botId })
      .then(setStatus)
      .catch(() => setStatusError('Could not reach the backend to check bot status.'));
  }

  // Prompt 0139 — re-runs whenever the switcher changes bot context, so
  // Compose's own guard notice/disabled Send/subscriber count always
  // reflect whichever bot is CURRENTLY selected, not whatever was selected
  // when the page first mounted.
  useEffect(() => {
    refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  function loadRecentBroadcasts() {
    if (isEdit) return;
    setRecent((r) => ({ ...r, loading: true, error: null }));
    // Window widened 5 -> 12 in prompt 0132 Revision 2 — a 13th broadcast
    // simply scrolls the oldest one out of this window; nothing is ever
    // deleted (the full history stays intact in the History tab either
    // way, this is only how many rows this one query asks for).
    listTelegramBroadcasts({ limit: 12, bot: botId })
      .then(({ broadcasts }) => setRecent({ loading: false, error: null, items: broadcasts }))
      .catch(() => setRecent({ loading: false, error: 'Could not load recent broadcasts.', items: [] }));
  }

  // Prompt 0134 — after a recurring broadcast is deactivated from its card
  // (or, via ViewBroadcastModal, from the View modal), refresh both the
  // recent list (so its badge/progress line reflects the new status right
  // away) and the status guard (so Compose's own blocked-notice/disabled
  // Send clears immediately, without waiting for a page reload).
  function handleRecurringDeactivated() {
    loadRecentBroadcasts();
    refreshStatus();
  }

  useEffect(() => {
    loadRecentBroadcasts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, botId]);

  // Prompt 0139 — registers this page's own "does the create-mode form have
  // unsaved content" check with the sidebar switcher's guard (see
  // useBotSwitchGuard.js). Always false in edit mode: editing an existing
  // broadcast's content is a different flow from the create-mode form this
  // guard exists to protect (matching isComposeFormEmpty's own create-mode
  // scope), and switching bot context away from an edit page doesn't
  // actually touch what's being edited anyway (that page's own PATCH is
  // still scoped to the broadcast's own bot via its id, per 0138's "derive
  // from the row" rule).
  useBotSwitchGuard(useCallback(() => !isEdit && !isComposeFormEmpty(titleDoc, bodyDoc), [isEdit, titleDoc, bodyDoc]));

  // Runs the scroll+focus that follows a successful "Salin ke form" —
  // deferred to an effect (rather than called inline in the click handler)
  // so it fires after React has actually committed the new field values to
  // the DOM, not before.
  useEffect(() => {
    if (!scrollFocusPending) return;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    titleFieldRef.current?.querySelector('.ProseMirror')?.focus();
    setScrollFocusPending(false);
  }, [scrollFocusPending]);

  useEffect(() => {
    if (!isEdit) return;
    getTelegramBroadcast(id)
      .then(({ broadcast }) => {
        // Prompt 0134 — content editing is also allowed while a broadcast
        // is actively 'recurring' (its next hourly round picks up the new
        // content), the same deliberate exception the backend's own
        // updateContent() already makes; this client-side courtesy check
        // just needs to recognize the same two statuses the server does.
        if (broadcast.status !== 'scheduled' && broadcast.status !== 'recurring') {
          setLoadError(`This broadcast can no longer be edited — it is already '${broadcast.status}'.`);
          return;
        }
        setFields((f) => ({
          ...f,
          mediaUrl: broadcast.mediaUrl || '',
          mediaFileId: broadcast.mediaFileId || '',
          mediaServerFilename: broadcast.mediaServerFilename || '',
          mediaType: broadcast.mediaType || '',
          buttons: broadcast.buttons || []
        }));
        // Legacy mediaUrl is a real URL — render it directly. A bare
        // mediaFileId (image or video) has no cheap renderable URL, so
        // it's left as null here and shown as a text placeholder instead
        // (see render below).
        if (broadcast.mediaUrl) setMediaPreviewUrl(broadcast.mediaUrl);
        setInitialTitleHtml(titleToEditorHtml(broadcast.title, broadcast.titleFormat));
        setInitialBodyHtml(bodyToEditorHtml(broadcast.body, broadcast.bodyFormat));
        setExistingScheduledAt(broadcast.scheduledAt);
        setExistingIsRecurring(broadcast.status === 'recurring');
        setExistingRecurringIntervalHours(broadcast.recurringIntervalHours ?? 1);
        setExistingBotId(broadcast.bot); // prompt 0139 — this broadcast's OWN bot, not the switcher's current position
      })
      .catch(() => setLoadError('Could not load this broadcast.'))
      .finally(() => setLoading(false));
  }, [id, isEdit]);

  function update(key, value) {
    setFields((f) => ({ ...f, [key]: value }));
    if (successMessage) setSuccessMessage(null); // stale "sent" notice shouldn't linger once the user starts a new one
  }

  // Same insert-at-cursor pattern as Title, for a specific button row's
  // text input — goes through updateButtonRow() so it's indistinguishable
  // from a manual edit to every other consumer of `fields.buttons`.
  function handleButtonTextEmoji(index, emojiNative) {
    const input = buttonTextInputRefs.current[index];
    const currentValue = fields.buttons[index]?.text || '';
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

  // Deliberately does NOT also clear successMessage here the way update()
  // does for title/target/schedule/button changes — a real bug caught via
  // prompt 0132's own E2E verification script before shipping: RichTextEditor
  // pushes its doc up once on every mount (see its own "keeps the parent
  // always in sync" comment), including the forced remount
  // resetFormAfterSend()/applyCopyToForm() trigger via editorKey — not just
  // a genuine user edit. A first attempt suppressed that one call with a
  // one-shot ref, but React 18 StrictMode (admin/src/app/main.jsx wraps the
  // whole app in it) double-invokes a freshly-mounted component's effects in
  // dev, firing that same mount-sync push twice — the one-shot suppression
  // covered the first (synthetic) call and missed the second (real) one,
  // wiping the just-shown success banner a moment after showing it. Rather
  // than chase StrictMode's exact double-invoke count with a fragile
  // counter, the simpler and robust fix is to not treat this generic
  // mount-triggered callback as a signal of user intent at all — a body-only
  // edit leaving a stale success banner visible a little longer is a minor,
  // honest trade-off, not a correctness bug.
  function handleBodyChange(doc) {
    setBodyDoc(doc);
  }

  // Same "just track the doc, no dirty-suppression logic needed" shape as
  // handleBodyChange — Compose's own dirty-check (isComposeFormEmpty,
  // wired into useBotSwitchGuard above) is purely content-based, unlike
  // WelcomePage's explicit isDirty flag, so there's no isInitialSync
  // special-casing needed here either.
  function handleTitleChange(doc) {
    setTitleDoc(doc);
  }

  function addButtonRow() {
    setFields((f) => ({ ...f, buttons: [...f.buttons, { text: '', url: '' }] }));
  }

  function updateButtonRow(index, key, value) {
    setFields((f) => ({
      ...f,
      buttons: f.buttons.map((b, i) => (i === index ? { ...b, [key]: value } : b))
    }));
  }

  function removeButtonRow(index) {
    setFields((f) => ({ ...f, buttons: f.buttons.filter((_, i) => i !== index) }));
  }

  // Revoke any local blob: preview URL on unmount so it doesn't leak.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

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
    // Set optimistically (before the upload even starts) so the right
    // preview element (img vs video) renders immediately and the OTHER
    // section disables right away — rolled back below on failure.
    setFields((f) => ({ ...f, mediaType: type }));
    setUploadingMedia(true);
    try {
      // Prompt 0141 — uploads to whichever bot actually owns this compose
      // session (create mode: the live switcher position; edit mode: the
      // broadcast's OWN bot — see effectiveBotId's own comment below).
      // The response's mediaServerFilename is what makes this media
      // reusable by the OTHER bot later, without a second upload.
      const uploadFn = type === 'video' ? uploadTelegramBroadcastVideo : uploadTelegramBroadcastImage;
      const { fileId, mediaServerFilename } = await uploadFn(file, { bot: effectiveBotId });
      setFields((f) => ({ ...f, mediaFileId: fileId, mediaServerFilename, mediaUrl: '' }));
    } catch (err) {
      setMediaError(err.message || `Could not upload this ${type}.`);
      URL.revokeObjectURL(localPreview);
      objectUrlRef.current = null;
      setMediaPreviewUrl(null);
      setFields((f) => ({ ...f, mediaType: '' }));
      e.target.value = '';
    } finally {
      setUploadingMedia(false);
    }
  }

  // Shared by handleRemoveMedia, resetFormAfterSend, and applyCopyToForm —
  // revokes any local blob: preview URL and clears the preview/error state,
  // without touching `fields` itself (each caller decides what `fields`
  // should become afterward).
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

  function handleRemoveMedia() {
    clearMediaPreview();
    setFields((f) => ({ ...f, mediaFileId: '', mediaServerFilename: '', mediaUrl: '', mediaType: '' }));
  }

  // Prompt 0132: after a successful create-mode send, the form used to
  // navigate away to History; now it stays on Compose and clears itself
  // back to a blank slate instead (see handleSubmit below). Edit mode is
  // untouched — it still navigates to History, a different context (see
  // that branch's own comment).
  function resetFormAfterSend() {
    setFields(EMPTY);
    setInitialTitleHtml('');
    setTitleDoc(null);
    setInitialBodyHtml('');
    setBodyDoc(null);
    setEditorKey((k) => k + 1); // force both RichTextEditor instances to remount empty — see that component's own mount-once comment
    clearMediaPreview();
  }

  // "Salin ke form" — see composeRecentCards.js's broadcastToComposeFields()
  // for what does/doesn't get copied (schedule always resets, legacy media
  // is skipped). Called either directly (form was empty) or after the user
  // confirms the overwrite Modal (form had content). Prompt 0141 — media
  // now carries over regardless of which bot is currently active (a real
  // server file behind it is bot-agnostic — see that function's own
  // comment); only genuinely legacy media (no server file at all) still
  // gets skipped, uniformly, no bot-context flag needed here anymore.
  function applyCopyToForm(broadcast) {
    const { fields: copiedFields, titleHtml, bodyHtml } = broadcastToComposeFields(broadcast);
    clearMediaPreview();
    setFields(copiedFields);
    setInitialTitleHtml(titleHtml);
    setTitleDoc(null);
    setInitialBodyHtml(bodyHtml);
    setBodyDoc(null);
    setEditorKey((k) => k + 1); // same remount-to-actually-change-content reasoning as resetFormAfterSend
    setSuccessMessage(null);
    setError(null);
    setCopyConfirm(null);
    setScrollFocusPending(true);
  }

  // Reused by both the card's own "Salin ke form" button and the one inside
  // ViewBroadcastModal (Revision 1) — same guard either way. Always closes
  // the View modal first (a no-op if it wasn't open): when the guard fires,
  // this makes the overwrite-confirm Modal REPLACE the View modal rather
  // than stack on top of it. Stacking was considered and rejected — Modal.jsx
  // attaches its own Escape-key listener per instance with no z-index/focus
  // coordination between instances, so two open at once would both react to
  // a single Escape press (closing both, or racing) instead of the
  // conventional "top modal closes first" behavior; replacing is simpler,
  // matches this app's existing one-modal-at-a-time pattern, and the user
  // already saw the content once in the View modal, so nothing is lost by
  // it disappearing the moment the confirm (or the applied copy) appears.
  function handleCopyToForm(broadcast) {
    setViewBroadcast(null);
    if (isComposeFormEmpty(titleDoc, bodyDoc)) {
      applyCopyToForm(broadcast);
      return;
    }
    setCopyConfirm(broadcast); // form has content — confirm the overwrite first (rendered as a Modal below)
  }

  // Shared by buildEditPayload/buildCreatePayload — the validation every
  // submission needs regardless of which of the two it is. Pure aside from
  // reading component state; throws on the first failure, same contract
  // handleSubmit already relied on before this was factored out.
  function validateCommonFields() {
    const buttonsError = validateButtons(fields.buttons);
    if (buttonsError) {
      throw new Error(buttonsError);
    }
    // iconCustomEmojiId (prompt 0153) carried through untrimmed (it's
    // always either null or a plain digits-only string with no whitespace
    // concern) — a real bug this fix corrects: this mapping used to name
    // only {text, url} explicitly, silently dropping it at submit time.
    const buttons = fields.buttons.map((b) => ({ text: b.text.trim(), url: b.url.trim(), iconCustomEmojiId: b.iconCustomEmojiId || null }));

    // Prompt 0149 — Title validated exactly like Message: empty-check,
    // link validation, then rendered to Telegram HTML. Checked first so a
    // missing/invalid title is reported before a missing message, matching
    // the field's own on-screen order.
    if (!titleDoc || isEditorTitleEmpty(titleDoc)) {
      throw new Error('Title is required.');
    }
    const titleLinkError = validateEditorLinks(titleDoc);
    if (titleLinkError) {
      throw new Error(titleLinkError);
    }
    const title = editorJsonToTelegramTitleHtml(titleDoc);

    if (!bodyDoc || isEditorDocEmpty(bodyDoc)) {
      throw new Error('Message is required.');
    }
    const linkError = validateEditorLinks(bodyDoc);
    if (linkError) {
      throw new Error(linkError);
    }
    const body = editorJsonToTelegramHtml(bodyDoc);

    if (uploadingMedia) {
      throw new Error('Wait for the media to finish uploading before sending.');
    }
    // mediaServerFilename included (prompt 0141) — a cross-bot copy has
    // real media attached (about to be sent) even while mediaFileId is
    // still blank, resolved lazily at actual send time.
    const hasMedia = Boolean(fields.mediaFileId || fields.mediaServerFilename || fields.mediaUrl);
    if (hasMedia) {
      // Prompt 0149 — title's own plain-text length (not fields.title,
      // which no longer exists) via the same editorPlainTextLength()
      // Message already uses — a single-paragraph title doc measures
      // identically to a title-specific variant would, so there's no need
      // for a separate helper.
      const captionLength = editorPlainTextLength(titleDoc) + 2 + editorPlainTextLength(bodyDoc);
      if (captionLength > MAX_CAPTION_LENGTH) {
        throw new Error(
          `Caption is too long with media attached (${captionLength}/${MAX_CAPTION_LENGTH} characters) — shorten the title or message, or remove the media.`
        );
      }
    }
    return { buttons, title, body };
  }

  function buildEditPayload() {
    const { buttons, title, body } = validateCommonFields();
    return {
      title,
      titleFormat: 'html',
      body,
      bodyFormat: 'html',
      mediaUrl: fields.mediaUrl || null,
      mediaFileId: fields.mediaFileId || null,
      mediaServerFilename: fields.mediaServerFilename || null,
      mediaType: fields.mediaType || null,
      buttons
    };
  }

  // Prompt 0139 — carries `bot: botId` so the backend creates this row
  // under whichever bot the switcher currently has active (see
  // resolveBotId() server-side; omitted here would silently default to
  // 'test', which is exactly what happens for the unmodified pre-0139
  // flow where botId is always 'test').
  function buildCreatePayload() {
    const { buttons, title, body } = validateCommonFields();
    let scheduledAt = null;
    const isRecurring = fields.sendMode === 'recurring';
    if (fields.sendMode === 'schedule') {
      // resolveScheduledAtIso expects { mode, todayTime, laterValue } —
      // ComposePage's own state calls the mode field "scheduleMode", so
      // this must be re-shaped rather than passing `fields` wholesale
      // (that mismatch was the root cause of Today always being rejected).
      const resolved = resolveScheduledAtIso({
        mode: fields.scheduleMode,
        todayTime: fields.todayTime,
        laterValue: fields.laterValue
      });
      if (resolved.error) throw new Error(resolved.error);
      scheduledAt = resolved.iso;
    }
    // Prompt 0164 — recurringStartsAt is only ever resolved when recurring
    // mode is active AND "Mulai pada jam tertentu" was chosen; "Mulai
    // sekarang" (the default) leaves it null, matching the backend's own
    // "NULL = start now" contract (recurringSchedule.js's
    // computeRecurringDue, migration 0023's own comment) — the SAME
    // resolveScheduledAtIso() the one-time schedule picker already uses,
    // reused via a second, independently-stateful <ScheduleFields> instance
    // below rather than a bespoke resolver.
    let recurringStartsAt = null;
    if (isRecurring && fields.recurringStartChoice === 'at') {
      const resolved = resolveScheduledAtIso({
        mode: fields.recurringScheduleMode,
        todayTime: fields.recurringTodayTime,
        laterValue: fields.recurringLaterValue
      });
      if (resolved.error) throw new Error(resolved.error);
      recurringStartsAt = resolved.iso;
    }
    return {
      bot: botId,
      title,
      titleFormat: 'html',
      body,
      bodyFormat: 'html',
      mediaUrl: fields.mediaUrl || null,
      mediaFileId: fields.mediaFileId || null,
      mediaServerFilename: fields.mediaServerFilename || null,
      mediaType: fields.mediaType || null,
      targetType: fields.targetType,
      targetChannelId: fields.targetType === 'channel' ? fields.targetChannelId : null,
      scheduledAt,
      // Prompt 0134 — mutually exclusive with scheduledAt (the "When"
      // dropdown only ever lets one of the three modes be selected at
      // once, so scheduledAt is always null here when isRecurring is
      // true). The server re-validates this exact exclusivity itself —
      // never trusted from the client alone.
      recurring: isRecurring,
      // Prompt 0164 — both only meaningful when recurring is true; the
      // server re-validates that combination itself too (adminTelegramBroadcastRoutes.js).
      recurringIntervalHours: isRecurring ? fields.recurringIntervalHours : undefined,
      recurringStartsAt,
      // Prompt 0234 (P1) — only ever sent as true, and only for a recurring
      // activation while another recurring broadcast is active; the server
      // re-validates both conditions itself.
      replaceActiveRecurring: isRecurring && activeRecurring && replaceActive ? true : undefined,
      buttons
    };
  }

  // The actual API call + success/error handling — factored out of
  // handleSubmit (prompt 0139) so the official-bot send guard can sit
  // BETWEEN "payload is valid" and "actually submit it": handleSubmit
  // builds+validates the payload first, and either calls this immediately
  // (trial bot, or edit mode) or holds it in `pendingSend` for the
  // confirmation Modal to call once the admin explicitly confirms.
  async function performSubmit(payload) {
    setSubmitting(true);
    setError(null);
    try {
      if (isEdit) {
        await updateTelegramBroadcastContent(id, payload);
        navigate('/broadcast/history');
        return;
      }
      await createTelegramBroadcast(payload);
      // Prompt 0132: stay on Compose instead of navigating to History, so
      // the content that was just sent doesn't "disappear" — reset to a
      // blank form, show an inline success notice, and refresh the recent-
      // broadcasts cards so the new one appears at the top immediately.
      // Prompt 0134: a recurring activation's own first round already
      // happened synchronously on the server by the time this response
      // comes back, so the notice says so rather than the generic "sent".
      setSuccessMessage(
        payload.recurring ? 'Recurring broadcast activated — first send is on its way.' : payload.scheduledAt ? 'Broadcast scheduled.' : 'Broadcast sent.'
      );
      resetFormAfterSend();
      loadRecentBroadcasts();
      refreshStatus(); // an active recurring broadcast now exists — refresh so the guard notice/disabled Send picks it up immediately
    } catch (err) {
      setError(err.message || (isEdit ? 'Could not save this broadcast.' : 'Could not send this broadcast.'));
    } finally {
      setSubmitting(false);
    }
  }

  // Prompt 0139 — the official-bot "pagar kirim": a create-mode submission
  // (immediate send, one-time schedule, OR recurring activation — all
  // three come from this same button and all three eventually reach real
  // subscribers/a real channel with no human in the loop at actual send
  // time, see sendGuard.js's own comment) is validated and built exactly
  // as before, but on the official bot it's held in `pendingSend` for an
  // explicit confirmation instead of submitting immediately. Editing an
  // existing broadcast's content, and every trial-bot submission, are
  // completely unaffected — zero added friction there, per the base
  // prompt's own explicit instruction.
  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);
    let payload;
    try {
      payload = isEdit ? buildEditPayload() : buildCreatePayload();
    } catch (err) {
      setError(err.message || (isEdit ? 'Could not save this broadcast.' : 'Could not send this broadcast.'));
      return;
    }
    if (isSendGuardRequired(botId, isEdit)) {
      setPendingSend(payload);
      return;
    }
    await performSubmit(payload);
  }

  const botConfigured = status?.botConfigured ?? true; // assume configured until we know otherwise, avoids a flash of the warning
  const activeRecurring = status?.activeRecurringBroadcast ?? null;
  // Prompt 0134 — blocked while ANY recurring broadcast is active, entirely
  // independent of which "When" mode is currently selected (this is the
  // server's own guard too — a plain scheduled/immediate send is rejected
  // just as much as a second recurring activation would be). Edit mode is
  // deliberately NOT gated on this — editing a broadcast's own content is
  // always a separate, always-allowed action here (including editing the
  // active recurring broadcast itself, per that prompt's own explicit
  // "Edit isi tetap diizinkan" design).
  // Prompt 0234 (P1) — a recurring activation with the explicit replace
  // checkbox ticked is allowed through the active-recurring block.
  const replaceUnblocks = fields.sendMode === 'recurring' && replaceActive;
  const canSend = isEdit ? !submitting : botConfigured && (!activeRecurring || replaceUnblocks) && !submitting && !uploadingMedia;
  // Prompt 0153 — contextual notice only, never blocks sending (per the
  // base prompt's own explicit "Kirim tetap diizinkan").
  const showPremiumEmojiWarning = shouldShowPremiumEmojiWarning({
    hasPremiumContent: hasPremiumEmojiContent({ titleDoc, bodyDoc, buttons: fields.buttons }),
    botId,
    targetType: fields.targetType
  });
  const isScheduling = fields.sendMode === 'schedule';
  const isRecurringMode = fields.sendMode === 'recurring';
  const imageAttached = fields.mediaType === 'image';
  const videoAttached = fields.mediaType === 'video';

  // Prompt 0139 introduced this to know which bot's Telegram client an
  // upload was hardcoded against; prompt 0141 (Stage C) turned that into a
  // real per-bot upload target instead of a disable switch — media is now
  // fully enabled for every bot (see the picker below, no more "coming
  // later" note). Originally named effectiveMediaBotId, used for exactly
  // one thing: which bot's storage chat handleFileSelected() should
  // upload to — edit mode uses the broadcast's OWN bot (existingBotId),
  // never the switcher's live position (matching this component's own
  // top-of-file "derive from the existing row" rule); create mode uses
  // the switcher's live botId. Falls back to the live botId if
  // existingBotId hasn't loaded yet (defensive only — the media picker
  // isn't actually reachable before `loading` clears, by which point
  // existingBotId is always set).
  //
  // Prompt 0161 — renamed (media -> plain) and reused as the value for
  // this whole page's <DataBotProvider> below, since Title/Message's
  // premium-emoji rendering and each button row's premium-icon control
  // need the exact same "which bot actually owns this content" answer
  // media upload already had to compute. This closes a REAL, independently
  // discovered bug, not just a rename: `RichTextEditor`/
  // `ButtonPremiumIconControl` used to be passed the raw switcher `botId`
  // directly (see this same investigation's own archive) — in edit mode,
  // after a fresh page load (which always resets the switcher to `'test'`,
  // per BotContext.jsx's own documented behavior) opening an `'official'`
  // broadcast for editing, premium emoji in its Title/Message/buttons
  // would have silently tried to resolve against the WRONG bot's library.
  // Media upload already avoided this exact mistake; the rest of the page
  // now shares its own already-correct answer instead of repeating it.
  const effectiveBotId = isEdit ? existingBotId ?? botId : botId;

  if (loading) return <div className="loading-state">Loading…</div>;

  return (
    <DataBotProvider value={effectiveBotId}>
    <main>
      <div className="page-head">
        <div>
          <h1>{isEdit ? 'Edit broadcast' : 'Broadcast — Telegram'}</h1>
          <p className="page-head__desc">
            {isEdit
              ? existingIsRecurring
                ? 'Message content only — target is unchanged here. The next automatic round picks up this new content; the recurring schedule itself is unaffected.'
                : 'Message content only — target and schedule are unchanged here. Use "Ubah waktu" in history to change the send time.'
              : 'One-way announcement to a Telegram channel or every subscriber who has started the bot. No reader tracking beyond delivery bookkeeping — never linked to any wallet identity.'}
          </p>
        </div>
      </div>

      {!isEdit && <BroadcastTabs />}

      {loadError && <div className="form-error" style={{ marginBottom: 16 }}>{loadError}</div>}

      {!loadError && (
        <>
          {!isEdit && status && !status.botConfigured && (
            <div className="form-error" style={{ marginBottom: 16 }}>
              Telegram bot is not configured on the backend (TELEGRAM_BOT_TOKEN unset) — sending is disabled until it is.
            </div>
          )}
          {!isEdit && status && status.botConfigured && !status.botConnected && (
            <div className="form-error" style={{ marginBottom: 16 }}>
              A bot token is configured, but the backend could not reach Telegram to verify it.
            </div>
          )}
          {!isEdit && statusError && <div className="form-error" style={{ marginBottom: 16 }}>{statusError}</div>}
          {!isEdit && activeRecurring && fields.sendMode !== 'recurring' && (
            <div className="form-error" style={{ marginBottom: 16 }}>
              A recurring broadcast (&ldquo;{titlePlainText(activeRecurring.title, activeRecurring.titleFormat)}&rdquo;) is currently active — deactivate it first
              (from its card below, or its detail page) before sending another broadcast.
            </div>
          )}
          {/* Prompt 0234 (P1) — for a recurring activation, the block becomes a
              choice: replace the active one atomically (its in flight round,
              if any, stops on its own within the worker's recheck bound). */}
          {!isEdit && activeRecurring && fields.sendMode === 'recurring' && (
            <div className="card" style={{ marginBottom: 16, padding: 12 }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={replaceActive}
                  onChange={(e) => setReplaceActive(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  Replace the active recurring broadcast (&ldquo;{titlePlainText(activeRecurring.title, activeRecurring.titleFormat)}&rdquo;).
                  It is deactivated the moment this one is activated; a round it is currently sending stops shortly after.
                </span>
              </label>
            </div>
          )}
          {!isEdit && successMessage && <div className="form-success" style={{ marginBottom: 16 }}>{successMessage}</div>}

          <div className="card form-card">
            <form className="form-grid" onSubmit={handleSubmit}>
              {error && <div className="form-error">{error}</div>}

              {/* Prompt 0149 — Title is now a RichTextEditor (singleLine
                  mode), the same rich-text field Message already is, with
                  its own toolbar (bold/italic/underline/strike/link/emoji) —
                  no separate Title-specific emoji button needed anymore. */}
              <div className="field" ref={titleFieldRef}>
                <label>Title</label>
                <RichTextEditor key={editorKey} initialContent={initialTitleHtml} onChange={handleTitleChange} singleLine />
                <span className="field-hint">
                  Bold, italic, underline, strikethrough, links, and emoji — always one line.
                </span>
              </div>

              <div className="field">
                <label>Message</label>
                <RichTextEditor key={editorKey} initialContent={initialBodyHtml} onChange={handleBodyChange} />
                <span className="field-hint">
                  Bold, italic, underline, strikethrough, and links — sent as Telegram-formatted text.
                </span>
              </div>

              <div className="field">
                <label>Image (optional)</label>
                <div className="image-picker">
                  {imageAttached && mediaPreviewUrl ? (
                    <img src={mediaPreviewUrl} alt="" className="image-picker__preview" />
                  ) : (
                    // Prompt 0141 — a cross-bot "Salin ke form" copy has a
                    // mediaServerFilename but a deliberately blank
                    // mediaFileId (resolved lazily per bot at send time —
                    // see composeRecentCards.js) — this placeholder must
                    // still show for that case, not just a freshly-uploaded
                    // file's own mediaFileId.
                    imageAttached && (fields.mediaFileId || fields.mediaServerFilename) && (
                      <div className="image-picker__placeholder">
                        <Icon name="image" /> Image attached
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
                {uploadingMedia && imageAttached && <span className="field-hint">Uploading…</span>}
                <span className="field-hint">JPG, PNG, or WEBP, up to 10 MB. One image OR one video per broadcast, not both.</span>
              </div>

              <div className="field">
                <label>Video (optional)</label>
                <div className="image-picker">
                  {videoAttached && mediaPreviewUrl ? (
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <video src={mediaPreviewUrl} controls className="image-picker__preview image-picker__preview--video" />
                  ) : (
                    videoAttached && (fields.mediaFileId || fields.mediaServerFilename) && (
                      <div className="image-picker__placeholder">
                        <Icon name="image" /> Video attached
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
                {uploadingMedia && videoAttached && (
                  <span className="field-hint">Uploading video… larger files can take a moment, this isn't stuck.</span>
                )}
                <span className="field-hint">MP4 only, up to 50 MB.</span>
              </div>

              {mediaError && <div className="form-error">{mediaError}</div>}
              <p className="field-hint" style={{ marginTop: -8 }}>
                Sent as the message's caption — max {MAX_CAPTION_LENGTH} characters combined (title + message) when
                an image or video is attached.
              </p>

              <div className="field">
                <label>Buttons (optional)</label>
                <div className="button-rows">
                  {fields.buttons.map((button, index) => (
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
                  Shown under the message as clickable Telegram buttons. Each opens its URL — no reader tracking. URLs
                  must start with https://.
                </span>
              </div>

              {isEdit ? (
                existingIsRecurring ? (
                  <p className="field-hint">
                    Recurring — sends every {existingRecurringIntervalHours} {existingRecurringIntervalHours === 1 ? 'hour' : 'hours'}, unchanged by
                    this edit. Deactivate from its card or detail page.
                  </p>
                ) : existingScheduledAt && (
                  <p className="field-hint">Scheduled for {formatDate(existingScheduledAt)} — unchanged by this edit.</p>
                )
              ) : (
                <>
                  <div className="form-row">
                    <div className="field">
                      <label htmlFor="targetType">Target</label>
                      <select id="targetType" value={fields.targetType} onChange={(e) => update('targetType', e.target.value)}>
                        <option value="subscribers">
                          Subscribers{status ? ` (${status.activeSubscriberCount} active)` : ''}
                        </option>
                        <option value="channel">A specific channel</option>
                      </select>
                    </div>
                    {fields.targetType === 'channel' && (
                      <div className="field">
                        <label htmlFor="targetChannelId">Channel ID or @username</label>
                        <input
                          id="targetChannelId"
                          placeholder="@fluxio_announcements"
                          value={fields.targetChannelId}
                          onChange={(e) => update('targetChannelId', e.target.value)}
                          required
                        />
                        <span className="field-hint">The bot must already be an admin of this channel.</span>
                      </div>
                    )}
                  </div>

                  <div className="form-row">
                    <div className="field">
                      <label htmlFor="sendMode">When</label>
                      <select id="sendMode" value={fields.sendMode} onChange={(e) => update('sendMode', e.target.value)}>
                        <option value="now">Send now</option>
                        <option value="schedule">Schedule for later</option>
                        <option value="recurring">Send automatically</option>
                      </select>
                    </div>
                  </div>
                  {isScheduling && (
                    <ScheduleFields
                      mode={fields.scheduleMode}
                      onModeChange={(scheduleMode) => update('scheduleMode', scheduleMode)}
                      todayTime={fields.todayTime}
                      onTodayTimeChange={(todayTime) => update('todayTime', todayTime)}
                      laterValue={fields.laterValue}
                      onLaterValueChange={(laterValue) => update('laterValue', laterValue)}
                    />
                  )}
                  {isScheduling && (
                    <p className="field-hint">
                      One-time send only, no recurrence. Recipients (for a subscribers-target broadcast) are
                      determined right when it goes out, not now.
                    </p>
                  )}
                  {/* Prompt 0164 — two bertingkat (cascading) controls once
                      automatic mode is picked: how often, then when the
                      first round goes out. Mirrors the one-time schedule
                      section's own visual pattern (form-row of selects,
                      ScheduleFields reused verbatim below it) rather than a
                      new layout. */}
                  {isRecurringMode && (
                    <div className="form-row">
                      <div className="field">
                        <label htmlFor="recurringIntervalHours">Repeat every</label>
                        <select
                          id="recurringIntervalHours"
                          value={fields.recurringIntervalHours}
                          onChange={(e) => update('recurringIntervalHours', Number(e.target.value))}
                        >
                          {Array.from({ length: 24 }, (_, i) => i + 1).map((hours) => (
                            <option key={hours} value={hours}>
                              {hours} {hours === 1 ? 'hour' : 'hours'}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor="recurringStartChoice">Start</label>
                        <select
                          id="recurringStartChoice"
                          value={fields.recurringStartChoice}
                          onChange={(e) => update('recurringStartChoice', e.target.value)}
                        >
                          <option value="now">Start now</option>
                          <option value="at">Start at a specific time</option>
                        </select>
                      </div>
                    </div>
                  )}
                  {isRecurringMode && fields.recurringStartChoice === 'at' && (
                    <ScheduleFields
                      idPrefix="recurringStart"
                      mode={fields.recurringScheduleMode}
                      onModeChange={(recurringScheduleMode) => update('recurringScheduleMode', recurringScheduleMode)}
                      todayTime={fields.recurringTodayTime}
                      onTodayTimeChange={(recurringTodayTime) => update('recurringTodayTime', recurringTodayTime)}
                      laterValue={fields.recurringLaterValue}
                      onLaterValueChange={(recurringLaterValue) => update('recurringLaterValue', recurringLaterValue)}
                    />
                  )}
                  {isRecurringMode && (
                    <p className="field-hint">
                      {fields.recurringStartChoice === 'at'
                        ? `Starts at the time above, then repeats every ${fields.recurringIntervalHours} ${fields.recurringIntervalHours === 1 ? 'hour' : 'hours'}, until deactivated from its card or detail page.`
                        : `Sends immediately on activation, then repeats every ${fields.recurringIntervalHours} ${fields.recurringIntervalHours === 1 ? 'hour' : 'hours'}, until deactivated from its card or detail page.`}{' '}
                      Only one recurring broadcast can be active at a time.
                    </p>
                  )}
                </>
              )}

              {showPremiumEmojiWarning && (
                <p className="field-hint field-hint--warning">
                  Emoji premium dan ikon tombol premium akan tampil sebagai emoji biasa atau tanpa ikon di target ini.
                </p>
              )}

              <div className="form-actions">
                {isEdit && (
                  <button type="button" className="btn" onClick={() => navigate('/broadcast/history')}>Cancel</button>
                )}
                <button type="submit" className="btn btn-primary" disabled={!canSend}>
                  {!isEdit && <Icon name={isRecurringMode ? 'refresh' : isScheduling ? 'clock' : 'send'} />}{' '}
                  {isEdit
                    ? (submitting ? 'Saving…' : 'Save changes')
                    : submitting
                      ? (isRecurringMode ? 'Activating…' : isScheduling ? 'Scheduling…' : 'Sending…')
                      : isRecurringMode ? 'Activate' : isScheduling ? 'Schedule' : 'Send'}
                </button>
              </div>
            </form>
          </div>

          {!isEdit && (
            <div className="recent-broadcasts">
              <h2 className="recent-broadcasts__heading">Broadcast terakhir</h2>
              <RecentBroadcastCards
                broadcasts={recent.items}
                loading={recent.loading}
                error={recent.error}
                onCopyToForm={handleCopyToForm}
                onView={setViewBroadcast}
                onDeactivated={handleRecurringDeactivated}
              />
            </div>
          )}
        </>
      )}

      {viewBroadcast && (
        <ViewBroadcastModal
          broadcast={viewBroadcast}
          onClose={() => setViewBroadcast(null)}
          onCopyToForm={handleCopyToForm}
          onDeactivated={() => {
            handleRecurringDeactivated();
            setViewBroadcast(null); // the row's own status just changed under it — close rather than show stale content
          }}
        />
      )}

      {copyConfirm && (
        <Modal title="Timpa isi form saat ini?" onClose={() => setCopyConfirm(null)}>
          <p>
            Form masih berisi konten yang belum dikirim. Menyalin &ldquo;{titlePlainText(copyConfirm.title, copyConfirm.titleFormat)}&rdquo; akan menimpanya.
          </p>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setCopyConfirm(null)}>Batal</button>
            <button type="button" className="btn btn-primary" onClick={() => applyCopyToForm(copyConfirm)}>
              Timpa dan salin
            </button>
          </div>
        </Modal>
      )}

      {/* Prompt 0139 — "pagar kirim mode resmi". Only ever rendered for a
          create-mode submission while the official bot is active (see
          isSendGuardRequired() in handleSubmit) — the trial bot's own flow
          never sets pendingSend at all, so this Modal simply never mounts
          there, zero added friction. */}
      {pendingSend && (
        <Modal title="Konfirmasi kirim — Bot Resmi" onClose={() => setPendingSend(null)}>
          <p>
            {buildSendGuardMessage({
              botUsername: botMeta.username,
              targetType: pendingSend.targetType,
              targetChannelId: pendingSend.targetChannelId,
              activeSubscriberCount: status?.activeSubscriberCount,
              isRecurring: pendingSend.recurring,
              recurringIntervalHours: pendingSend.recurringIntervalHours,
              recurringStartsAt: pendingSend.recurringStartsAt
            })}
          </p>
          <p className="field-hint field-hint--warning">Bot resmi mengirim ke user sungguhan — periksa kembali sebelum melanjutkan.</p>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setPendingSend(null)}>Batal</button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                const payload = pendingSend;
                setPendingSend(null);
                performSubmit(payload);
              }}
            >
              {pendingSend.recurring ? 'Aktifkan' : pendingSend.scheduledAt ? 'Jadwalkan' : 'Kirim'}
            </button>
          </div>
        </Modal>
      )}
    </main>
    </DataBotProvider>
  );
}
