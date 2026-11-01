import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  getAnnouncement,
  createAnnouncement,
  updateAnnouncement
} from '../../services/announcementsApi.js';
import { toDatetimeLocalValue, fromDatetimeLocalValue } from '../../utils/formatDate.js';
import { LEVEL_OPTIONS, TARGET_OPTIONS, targetPlatformLabel } from './announcementsStatus.js';
import { formatScheduleSummary } from './scheduleSummary.js';
import RichTextEditor from '../broadcast/telegram/RichTextEditor.jsx';
import {
  editorJsonToTelegramHtml,
  editorJsonToTelegramTitleHtml,
  validateEditorLinks,
  isEditorDocEmpty,
  isEditorTitleEmpty,
  bodyToEditorHtml,
  titleToEditorHtml
} from '../../components/editorTelegramFormat.js';

const EMPTY = { level: 'info', targetPlatform: 'all', startsAt: '', endsAt: '' };

/**
 * Prompt 0163 — Title/Body became RichTextEditor fields
 * (premiumEnabled={false}: no premiumEmoji node, no Premium picker tab, no
 * botId/DataBotProvider involvement at all — Announcements aren't a
 * Telegram concept, so premium custom emoji simply doesn't apply, and this
 * page deliberately has no <DataBotProvider> anywhere in its tree). The
 * standalone 0159-era emoji-picker buttons on Title/Body are gone — the
 * editor's own toolbar already carries one (Standard tab only, since
 * premiumEnabled is false — see EmojiPickerButton.jsx's own default
 * behavior, unchanged). The "Body (Markdown supported)" label is gone too:
 * that label was never actually true — no consumer of GET /api/announcements
 * has ever existed to render Markdown (confirmed by grepping apps/ and
 * packages/ before this prompt started) — replaced with a short, accurate
 * hint about what IS actually supported now.
 *
 * Serialization reuses the exact same functions ComposePage.jsx's own
 * Title/Message fields use (editorJsonToTelegramTitleHtml/
 * editorJsonToTelegramHtml, both now in admin/src/components/
 * editorTelegramFormat.js — see that file's own header for the move), so
 * there's one renderer for this restricted HTML shape, not two independently
 * maintained ones. Always sends titleFormat/bodyFormat: 'html' on save,
 * exactly like ComposePage's own buildEditPayload — the editor's own
 * serialization already produces safe, minimal-shape HTML regardless of
 * whether any mark was actually used, matching this codebase's
 * already-established "html' = composed/re-saved through the rich-text
 * editor" convention (migration 0010's own header, mirrored by 0021 here).
 *
 * No separate read-only "detail" view exists for an announcement (only this
 * reused create/edit form, and the list's own Title cell — see
 * AnnouncementTable.jsx's own FormattedRichText usage) — reopening THIS
 * form for an existing 'plain'-format announcement is itself the round-trip
 * case: titleToEditorHtml/bodyToEditorHtml escape a legacy plain value
 * first (so its literal `<`/`>`/`&` display as typed, never misread as
 * markup), and only ever produce real HTML tags for an already-'html'-format
 * row. Saving again always re-serializes through the editor, so a
 * previously-'plain' row correctly becomes 'html' once explicitly re-saved
 * — the same "round-trip through the editor upgrades the format" behavior
 * "Edit isi" already has for broadcasts.
 */
export default function AnnouncementForm() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();

  const [fields, setFields] = useState(EMPTY);
  const [loading, setLoading] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  // Prompt 0171 — the "Display schedule" section's own open/closed state.
  // Purely a display concern: closing it never touches fields.startsAt/
  // endsAt (those stay in `fields` regardless, see the panel's own
  // conditional render below), and it never affects validation/submit.
  // Always closed on create; the edit-load effect below opens it
  // automatically when the loaded announcement already has a value.
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const [initialTitleHtml, setInitialTitleHtml] = useState('');
  const [titleDoc, setTitleDoc] = useState(null);
  const [initialBodyHtml, setInitialBodyHtml] = useState('');
  const [bodyDoc, setBodyDoc] = useState(null);

  useEffect(() => {
    if (!isEdit) return;
    getAnnouncement(id)
      .then(({ announcement }) => {
        setInitialTitleHtml(titleToEditorHtml(announcement.title, announcement.titleFormat));
        setInitialBodyHtml(bodyToEditorHtml(announcement.body, announcement.bodyFormat));
        setFields({
          level: announcement.level,
          targetPlatform: announcement.targetPlatform,
          startsAt: toDatetimeLocalValue(announcement.startsAt),
          endsAt: toDatetimeLocalValue(announcement.endsAt)
        });
        // Prompt 0171 — auto-open the schedule section when the loaded
        // announcement already has a value, so an existing schedule is
        // never hidden by default on edit (create-only default is closed).
        if (announcement.startsAt || announcement.endsAt) {
          setScheduleOpen(true);
        }
      })
      .catch(() => setError('Could not load this announcement.'))
      .finally(() => setLoading(false));
  }, [id, isEdit]);

  function update(key, value) {
    setFields((f) => ({ ...f, [key]: value }));
  }

  function handleTitleChange(doc) {
    setTitleDoc(doc);
  }

  function handleBodyChange(doc) {
    setBodyDoc(doc);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    if (!titleDoc || isEditorTitleEmpty(titleDoc)) {
      setError('Title is required.');
      return;
    }
    const titleLinkError = validateEditorLinks(titleDoc);
    if (titleLinkError) {
      setError(titleLinkError);
      return;
    }
    const title = editorJsonToTelegramTitleHtml(titleDoc);

    if (!bodyDoc || isEditorDocEmpty(bodyDoc)) {
      setError('Body is required.');
      return;
    }
    const bodyLinkError = validateEditorLinks(bodyDoc);
    if (bodyLinkError) {
      setError(bodyLinkError);
      return;
    }
    const body = editorJsonToTelegramHtml(bodyDoc);

    setSubmitting(true);
    const payload = {
      title,
      titleFormat: 'html',
      body,
      bodyFormat: 'html',
      level: fields.level,
      targetPlatform: fields.targetPlatform,
      startsAt: fromDatetimeLocalValue(fields.startsAt),
      endsAt: fromDatetimeLocalValue(fields.endsAt)
    };
    try {
      if (isEdit) {
        await updateAnnouncement(id, payload);
      } else {
        await createAnnouncement(payload);
      }
      navigate('/announcements');
    } catch (err) {
      setError(err.message || 'Could not save this announcement.');
    } finally {
      setSubmitting(false);
    }
  }

  // Prompt 0171 — the collapsed header's own summary text, recomputed
  // fresh on every render from `fields` (cheap, no memoization needed).
  const scheduleSummary = formatScheduleSummary(fields);

  if (loading) return <div className="loading-state">Loading…</div>;

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>{isEdit ? 'Edit announcement' : 'New announcement'}</h1>
          <p className="page-head__desc">Saved as a draft by default — use Publish from the list once it's ready.</p>
        </div>
      </div>

      <div className="card form-card">
        <form className="form-grid" onSubmit={handleSubmit}>
          {error && <div className="form-error">{error}</div>}

          <div className="field">
            <label>Title</label>
            <RichTextEditor
              initialContent={initialTitleHtml}
              onChange={handleTitleChange}
              singleLine
              premiumEnabled={false}
            />
            <span className="field-hint">Bold, italic, underline, strikethrough, and links — always one line.</span>
          </div>

          <div className="field">
            <label>Body</label>
            <RichTextEditor initialContent={initialBodyHtml} onChange={handleBodyChange} premiumEnabled={false} />
            <span className="field-hint">Bold, italic, underline, strikethrough, and links.</span>
          </div>

          <div className="form-row">
            <div className="field">
              <label htmlFor="level">Level</label>
              <select id="level" value={fields.level} onChange={(e) => update('level', e.target.value)}>
                {LEVEL_OPTIONS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="targetPlatform">Target platform</label>
              <select id="targetPlatform" value={fields.targetPlatform} onChange={(e) => update('targetPlatform', e.target.value)}>
                {TARGET_OPTIONS.map((t) => <option key={t} value={t}>{targetPlatformLabel(t)}</option>)}
              </select>
            </div>
          </div>

          <div className="card announcement-schedule">
            <button
              type="button"
              className="announcement-schedule__header"
              onClick={() => setScheduleOpen((o) => !o)}
              aria-expanded={scheduleOpen}
              aria-controls="announcement-schedule-panel"
            >
              <span className="announcement-schedule__title">Display schedule (optional)</span>
              {!scheduleOpen && scheduleSummary && (
                <span className="announcement-schedule__summary">{scheduleSummary}</span>
              )}
              <span className="announcement-schedule__chevron" aria-hidden="true">▾</span>
            </button>

            {scheduleOpen && (
              <div className="announcement-schedule__panel" id="announcement-schedule-panel">
                <div className="form-row">
                  <div className="field">
                    <label htmlFor="startsAt">Starts at (optional)</label>
                    <input
                      id="startsAt"
                      type="datetime-local"
                      value={fields.startsAt}
                      onChange={(e) => update('startsAt', e.target.value)}
                    />
                    <span className="field-hint">Leave blank to be visible immediately once published.</span>
                  </div>
                  <div className="field">
                    <label htmlFor="endsAt">Ends at (optional)</label>
                    <input
                      id="endsAt"
                      type="datetime-local"
                      value={fields.endsAt}
                      onChange={(e) => update('endsAt', e.target.value)}
                    />
                    <span className="field-hint">Leave blank to stay visible indefinitely.</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="form-actions">
            <button type="button" className="btn" onClick={() => navigate('/announcements')}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
