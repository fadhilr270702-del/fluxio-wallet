/**
 * Pure helpers backing prompt 0132's two Compose-page additions — the
 * "Broadcast terakhir" recent-cards section and its "Salin ke form"
 * (copy-to-form) action — kept framework-free and side-effect-free so they
 * can be unit tested directly (see test/composeRecentCards.test.js) without
 * mounting React, TipTap, or hitting the network. ComposePage.jsx is the
 * only consumer; it owns all the actual state/DOM effects (scrolling,
 * focusing, revoking object URLs, forcing RichTextEditor to remount via a
 * changing key — RichTextEditor reads its `initialContent` prop once at
 * mount only, so swapping it after mount requires a fresh mount, not a
 * plain state update).
 */
import { bodyToEditorHtml, isEditorDocEmpty, isEditorTitleEmpty, titleToEditorHtml } from './editorTelegramFormat.js';

/**
 * The Compose form's blank slate — used both for the form's initial
 * `useState` and to reset it after a successful send (prompt 0132's "don't
 * navigate away, clear the form instead" behavior change). Moved here from
 * ComposePage's own local `EMPTY` constant so both call sites (initial
 * state and post-send reset) share exactly one definition.
 *
 * Prompt 0149 — `title` itself is REMOVED from this object: Title is now a
 * RichTextEditor (singleLine mode), the same architecture Message already
 * uses — its own doc lives in ComposePage's separate `titleDoc`/
 * `initialTitleHtml` state, exactly parallel to `bodyDoc`/`initialBodyHtml`,
 * not as a plain string field here.
 */
export const EMPTY_COMPOSE_FIELDS = {
  mediaUrl: '', // legacy broadcasts only — never written to by a new upload or by a copy
  mediaFileId: '',
  // Prompt 0141 (Stage C) — the bot-agnostic server file this media was
  // actually uploaded from, if any. Carried forward by "Salin ke form"
  // even cross-bot (see broadcastToComposeFields below); mediaFileId never
  // is, since a file_id only means anything for the bot that issued it —
  // the backend resolves a fresh one for whichever bot actually sends,
  // lazily, from this filename (see broadcastMedia.js's own header).
  mediaServerFilename: '',
  mediaType: '', // '' | 'image' | 'video' — image and video are mutually exclusive, one slot
  targetType: 'subscribers',
  targetChannelId: '',
  sendMode: 'now', // 'now' | 'schedule' | 'recurring'
  scheduleMode: 'today', // 'today' | 'later'
  todayTime: '',
  laterValue: '',
  // Prompt 0164 — recurring's own cadence controls, cascading only once
  // sendMode === 'recurring'. recurringStartChoice/recurringScheduleMode/
  // recurringTodayTime/recurringLaterValue deliberately mirror
  // scheduleMode/todayTime/laterValue's own shape+meaning exactly (reusing
  // ScheduleFields.jsx + resolveScheduledAtIso() unchanged for the "at a
  // specific time" picker — see ComposePage.jsx's own comment on why this
  // is a SEPARATE state quadruplet rather than sharing the schedule one:
  // "Schedule for later" and "start the recurring cadence" are two
  // independent choices that can never both apply to the same submission
  // (sendMode is a single select), but keeping them as distinct fields
  // avoids any risk of one silently reading stale state left over from the
  // other mode).
  recurringIntervalHours: 1, // 1..24
  recurringStartChoice: 'now', // 'now' | 'at'
  recurringScheduleMode: 'today', // 'today' | 'later'
  recurringTodayTime: '',
  recurringLaterValue: '',
  buttons: [] // optional inline URL buttons: [{ text, url }], one per row
};

/**
 * True when the compose form currently holds nothing worth protecting —
 * title empty AND message body empty. Drives the "Salin ke form" overwrite
 * guard (prompt 0132 step 4): an empty form copies immediately, a
 * non-empty one asks for confirmation first via Modal.jsx. `titleDoc`/
 * `bodyDoc` may be null (their RichTextEditor hasn't mounted/pushed its
 * initial doc up yet, or the form was just reset) — treated the same as an
 * empty document. Prompt 0149 — `titleDoc` replaces the old plain
 * `fields.title` string check, since Title is now a doc-backed
 * RichTextEditor exactly like Message.
 */
export function isComposeFormEmpty(titleDoc, bodyDoc) {
  const titleEmpty = !titleDoc || isEditorTitleEmpty(titleDoc);
  const bodyEmpty = !bodyDoc || isEditorDocEmpty(bodyDoc);
  return titleEmpty && bodyEmpty;
}

/**
 * Turns a fetched broadcast (the same shape listTelegramBroadcasts()/
 * getTelegramBroadcast() already return) into a ready-to-apply compose-form
 * fields object plus the editor's starting HTML — everything "Salin ke
 * form" needs, computed in one pure step so ComposePage's click handler is
 * just: guard, then `setFields(result.fields)` / `setInitialBodyHtml(result.bodyHtml)`.
 *
 * Deliberately excluded from the copy (prompt 0132 step 3):
 *  - Schedule: sendMode always resets to 'now', scheduleMode/todayTime/
 *    laterValue always reset to their EMPTY_COMPOSE_FIELDS defaults. A past
 *    send's own timing is never meaningful for a new one.
 *  - Legacy media: a broadcast with a bare `mediaUrl` and no `mediaFileId`
 *    (pre-file_id broadcasts, see ComposePage's edit-mode loader comment)
 *    has no Telegram file reference left to reuse — there's no upload slot
 *    that accepts a raw URL, so copying `mediaUrl` into `mediaFileId` would
 *    either silently misbehave or require inventing a new code path just
 *    for this one case. Skipped on purpose; `mediaSkipped` tells the caller
 *    to show a small "media tidak dapat disalin" note instead of copying
 *    nothing silently.
 *
 * Prompt 0141 (Stage C) replaces 0139's own `forceSkipMedia` flag entirely:
 * now that broadcast media has a real, bot-agnostic server file behind it
 * (see backend/src/telegram/broadcastMedia.js), a copy's media is
 * copyable cross-bot whenever that server file exists — the backend
 * resolves a fresh file_id for whichever bot actually ends up sending it,
 * lazily, the first time it needs to (uploading the bytes to that bot's
 * storage chat at most once). `mediaFileId` itself is deliberately NEVER
 * carried forward by this copy — it's only ever meaningful for the bot
 * that issued it, and the new compose session might end up sending via a
 * DIFFERENT bot than whatever was active at copy time (the admin can still
 * switch bots after copying, before submitting) — so the fresh compose
 * form always starts with an empty mediaFileId and lets the same lazy
 * resolution mechanism fill it in at actual send time, exactly like a
 * cross-bot copy's target-bot row does. The only broadcasts still
 * uncopyable are genuinely LEGACY ones with no server file at all — either
 * pre-file_id (bare mediaUrl) or pre-Stage-C (a real mediaFileId, but
 * uploaded before this prompt ever stored the bytes server-side) — both
 * degrade with the same existing "can't copy" note, uniformly, regardless
 * of which bot the copy would target.
 */
export function broadcastToComposeFields(broadcast) {
  const hasServerFile = Boolean(broadcast.mediaServerFilename);
  const hadAnyMedia = Boolean(broadcast.mediaFileId) || Boolean(broadcast.mediaUrl);
  const mediaSkipped = hadAnyMedia && !hasServerFile;

  return {
    fields: {
      ...EMPTY_COMPOSE_FIELDS,
      mediaServerFilename: hasServerFile ? broadcast.mediaServerFilename : '',
      mediaType: hasServerFile ? broadcast.mediaType || '' : '',
      targetType: broadcast.targetType || 'subscribers',
      targetChannelId: broadcast.targetType === 'channel' ? broadcast.targetChannelId || '' : '',
      // Prompt 0164 — copying FROM a recurring broadcast carries its own
      // interval forward (a genuinely reusable "how often" preference), so
      // if the admin later switches sendMode back to 'recurring' on this
      // new draft, the interval starts pre-filled at whatever the original
      // used rather than resetting to the 1-hour default. recurringStartsAt
      // is deliberately NEVER copied, past OR future — sendMode itself
      // already always resets to 'now' on copy (this object's own
      // EMPTY_COMPOSE_FIELDS spread above), matching this codebase's
      // existing "a past send's own timing is never meaningful for a new
      // one" precedent (this file's own header comment, originally about
      // scheduledAt) — extending that same reasoning to a recurring
      // anchor: even a still-future original start time would very likely
      // have passed by the time this new copy is actually reviewed and
      // submitted, and forcing a fresh, explicit choice avoids a stale
      // date silently carrying over unnoticed.
      recurringIntervalHours: broadcast.isRecurring ? (broadcast.recurringIntervalHours ?? 1) : EMPTY_COMPOSE_FIELDS.recurringIntervalHours,
      // iconCustomEmojiId (prompt 0153) round-trips the same as text/url —
      // a real bug this fix corrects: the field was silently dropped on
      // "Salin ke form" before this, since this mapping used to name only
      // {text, url} explicitly. Only added to the object when actually
      // present, so a button with none stays byte-identical to its
      // pre-0153 {text, url} shape (matches buildInlineKeyboard's own
      // "no key at all when absent" convention).
      buttons: (broadcast.buttons || []).map((b) => ({
        text: b.text,
        url: b.url,
        ...(b.iconCustomEmojiId ? { iconCustomEmojiId: b.iconCustomEmojiId } : {})
      }))
    },
    // Prompt 0149 — titleHtml seeds the Title singleLine editor the same
    // way bodyHtml already seeds Message; titleToEditorHtml handles both
    // a legacy 'plain' title (escaped, so literal < > survive) and an
    // 'html' one (passed through, already-safe markup) identically to how
    // bodyToEditorHtml already treats body.
    titleHtml: titleToEditorHtml(broadcast.title, broadcast.titleFormat),
    bodyHtml: bodyToEditorHtml(broadcast.body, broadcast.bodyFormat),
    mediaSkipped
  };
}

/**
 * The badge-note condition used by RecentBroadcastCards/ViewBroadcastModal
 * — a broadcast's media can't be copied into a NEW form because it's
 * genuinely legacy (see broadcastToComposeFields's own comment: no server
 * file exists to resolve a fresh file_id from, for any bot). No longer
 * bot-dependent as of prompt 0141 — a broadcast with a real server file is
 * copyable into either bot's form now.
 */
export function isMediaUncopyable(broadcast) {
  const hasServerFile = Boolean(broadcast.mediaServerFilename);
  const hadAnyMedia = Boolean(broadcast.mediaFileId) || Boolean(broadcast.mediaUrl);
  return hadAnyMedia && !hasServerFile;
}

/**
 * The user-visible reason text for RecentBroadcastCards'/ViewBroadcastModal's
 * own "can't copy this media" note — never a generic label, per prompt
 * 0139's own "jangan sembunyikan diam-diam" instruction, carried forward
 * unchanged here. Returns null when nothing needs skipping.
 */
export function mediaSkipReasonNote(broadcast) {
  if (isMediaUncopyable(broadcast)) {
    return 'Media tidak dapat disalin (broadcast lama, sebelum penyimpanan file server-side).';
  }
  return null;
}

function stripTagsAndUnescape(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Plain-text, single-line, length-capped snippet of a broadcast's message
 * for the "Broadcast terakhir" cards — never rendered as HTML (React text
 * node only), so this just needs to be readable, not safe-to-inject.
 * `bodyFormat 'html'` bodies (see editorTelegramFormat.js) carry real
 * `<b>/<i>/<u>/<s>/<a>` tags and HTML-escaped text; `'plain'` (legacy)
 * bodies are already raw text. `\n` line breaks (one per paragraph) are
 * collapsed to spaces since a card excerpt is one line, not a paragraph
 * list.
 */
export function broadcastPlainTextExcerpt(broadcast, maxLength = 140) {
  const raw = broadcast.bodyFormat === 'html' ? stripTagsAndUnescape(broadcast.body) : String(broadcast.body || '');
  const singleLine = raw.replace(/\s*\n+\s*/g, ' ').trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength).trimEnd()}…`;
}

/**
 * Plain-text title, for every place a title is interpolated INTO a larger
 * plain string rather than displayed as the primary formatted content
 * (prompt 0149) — a Modal's own `title` prop (also used as its
 * `aria-label`, which structurally can't hold JSX), or a title quoted
 * inside a confirmation sentence ("No more automatic sends will happen for
 * "TITLE"..."). Genuine title DISPLAY surfaces (History table cell, Recent
 * card heading, View modal, Detail page h1) use FormattedTelegramText.jsx
 * instead, to actually show bold/italic/link formatting — this is
 * specifically for the surfaces where that isn't possible/appropriate.
 */
export function titlePlainText(title, titleFormat) {
  return titleFormat === 'html' ? stripTagsAndUnescape(title) : String(title || '');
}
