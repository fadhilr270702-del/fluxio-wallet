import { describe, it, expect } from 'vitest';
import {
  EMPTY_COMPOSE_FIELDS,
  isComposeFormEmpty,
  broadcastToComposeFields,
  broadcastPlainTextExcerpt,
  isMediaUncopyable,
  mediaSkipReasonNote
} from '../composeRecentCards.js';

// Prompt 0149 — titleDoc replaces the old plain fields.title string; a
// title doc has the exact same shape as a body doc (one paragraph of
// text nodes), just always single-paragraph by construction.
function titleDocWithText(text) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}
const EMPTY_TITLE_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

describe('isComposeFormEmpty', () => {
  it('is true for a completely blank form (initial state)', () => {
    expect(isComposeFormEmpty(null, null)).toBe(true);
  });

  it('is false once a title is typed, even with no body yet', () => {
    expect(isComposeFormEmpty(titleDocWithText('Hello'), null)).toBe(false);
  });

  it('is false once the body has visible text, even with no title', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi there' }] }] };
    expect(isComposeFormEmpty(null, doc)).toBe(false);
  });

  it('is true for a doc with only empty paragraphs (TipTap default empty state)', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph' }] };
    expect(isComposeFormEmpty(EMPTY_TITLE_DOC, doc)).toBe(true);
  });

  it('whitespace-only title still counts as empty', () => {
    expect(isComposeFormEmpty(titleDocWithText('   '), null)).toBe(true);
  });
});

describe('broadcastToComposeFields', () => {
  const baseBroadcast = {
    title: 'Maintenance window',
    titleFormat: 'plain',
    body: '<b>Hello</b> world',
    bodyFormat: 'html',
    mediaUrl: null,
    mediaFileId: 'file-abc-123',
    mediaServerFilename: 'broadcast-media-abc-123.jpg',
    mediaType: 'image',
    targetType: 'channel',
    targetChannelId: '@fluxio_announcements',
    buttons: [{ text: 'Learn more', url: 'https://fluxio.example/status' }],
    // Schedule fields present on a real fetched row — must never survive the copy.
    scheduledAt: '2026-09-01T10:00:00.000Z',
    status: 'completed'
  };

  it('converts the stored title into editor HTML via titleToEditorHtml, and target/buttons/server file across untouched — but never the source mediaFileId', () => {
    const { fields, titleHtml, mediaSkipped } = broadcastToComposeFields(baseBroadcast);
    expect(titleHtml).toBe('<p>Maintenance window</p>');
    expect(fields.targetType).toBe('channel');
    expect(fields.targetChannelId).toBe('@fluxio_announcements');
    expect(fields.mediaServerFilename).toBe('broadcast-media-abc-123.jpg');
    expect(fields.mediaType).toBe('image');
    // Prompt 0141 — mediaFileId is only ever meaningful for the bot that
    // issued it, and this copy might end up submitted under a different
    // bot than whatever's active right now; the fresh compose session
    // always resolves its own file_id lazily at send time, from the
    // server file alone.
    expect(fields.mediaFileId).toBe('');
    expect(fields.buttons).toEqual([{ text: 'Learn more', url: 'https://fluxio.example/status' }]);
    expect(mediaSkipped).toBe(false);
  });

  // Prompt 0153 — iconCustomEmojiId must survive "Salin ke form" the same
  // way text/url already do; a real bug this fix corrects (the old mapping
  // named only {text, url} explicitly, silently dropping anything else).
  it('carries a button\'s iconCustomEmojiId across on "Salin ke form"', () => {
    const { fields } = broadcastToComposeFields({
      ...baseBroadcast,
      buttons: [{ text: 'Learn more', url: 'https://fluxio.example/status', iconCustomEmojiId: '5267500801240092311' }]
    });
    expect(fields.buttons).toEqual([
      { text: 'Learn more', url: 'https://fluxio.example/status', iconCustomEmojiId: '5267500801240092311' }
    ]);
  });

  it('a button with no iconCustomEmojiId stays byte-identical to its pre-0153 {text, url} shape', () => {
    const { fields } = broadcastToComposeFields(baseBroadcast);
    expect(Object.keys(fields.buttons[0])).toEqual(['text', 'url']);
  });

  it('an html-format title is passed through as-is (already-safe markup), not re-escaped', () => {
    const { titleHtml } = broadcastToComposeFields({ ...baseBroadcast, title: '<b>Big Sale</b>', titleFormat: 'html' });
    expect(titleHtml).toBe('<p><b>Big Sale</b></p>');
  });

  it('a legacy plain title with literal < > is escaped so it displays as text, not markup', () => {
    const { titleHtml } = broadcastToComposeFields({ ...baseBroadcast, title: 'Sale <today>', titleFormat: 'plain' });
    expect(titleHtml).toBe('<p>Sale &lt;today&gt;</p>');
  });

  it('always resets schedule fields to the EMPTY defaults, regardless of the source broadcast', () => {
    const { fields } = broadcastToComposeFields(baseBroadcast);
    expect(fields.sendMode).toBe('now');
    expect(fields.scheduleMode).toBe('today');
    expect(fields.todayTime).toBe('');
    expect(fields.laterValue).toBe('');
  });

  // Prompt 0164 — recurring's own start-time controls always reset too,
  // same "a past send's own timing is never meaningful for a new one"
  // reasoning as scheduleMode/todayTime/laterValue just above — extended
  // explicitly to recurringStartsAt (never copied, even when still in the
  // future at copy time — see this file's own header comment for the full
  // reasoning).
  it('always resets the recurring start-time controls to the EMPTY defaults, regardless of the source broadcast', () => {
    const { fields } = broadcastToComposeFields({ ...baseBroadcast, isRecurring: true, recurringStartsAt: '2099-01-01T00:00:00.000Z' });
    expect(fields.recurringStartChoice).toBe('now');
    expect(fields.recurringScheduleMode).toBe('today');
    expect(fields.recurringTodayTime).toBe('');
    expect(fields.recurringLaterValue).toBe('');
  });

  it('copies recurringIntervalHours forward when the source broadcast was recurring', () => {
    const { fields } = broadcastToComposeFields({ ...baseBroadcast, isRecurring: true, recurringIntervalHours: 6 });
    expect(fields.recurringIntervalHours).toBe(6);
  });

  it('defaults recurringIntervalHours to 1 when the source broadcast was never recurring', () => {
    const { fields } = broadcastToComposeFields({ ...baseBroadcast, isRecurring: false });
    expect(fields.recurringIntervalHours).toBe(1);
  });

  it('converts the stored body back into editor HTML via bodyToEditorHtml', () => {
    const { bodyHtml } = broadcastToComposeFields(baseBroadcast);
    expect(bodyHtml).toBe('<p><b>Hello</b> world</p>');
  });

  it('skips legacy media (a real mediaFileId but no server file) and flags it, copying neither mediaFileId nor mediaUrl', () => {
    const legacy = { ...baseBroadcast, mediaServerFilename: null };
    const { fields, mediaSkipped } = broadcastToComposeFields(legacy);
    expect(mediaSkipped).toBe(true);
    expect(fields.mediaServerFilename).toBe('');
    expect(fields.mediaFileId).toBe('');
    expect(fields.mediaType).toBe('');
    expect(fields.mediaUrl).toBe(''); // never populated from the source's mediaUrl — no upload slot accepts a raw URL
  });

  it('skips the oldest legacy shape too (bare mediaUrl, no mediaFileId, no server file)', () => {
    const veryLegacy = { ...baseBroadcast, mediaFileId: null, mediaServerFilename: null, mediaUrl: 'https://old-cdn.example/image.jpg' };
    const { fields, mediaSkipped } = broadcastToComposeFields(veryLegacy);
    expect(mediaSkipped).toBe(true);
    expect(fields.mediaServerFilename).toBe('');
  });

  it('clears targetChannelId when copying a subscribers-targeted broadcast', () => {
    const subscribersBroadcast = { ...baseBroadcast, targetType: 'subscribers', targetChannelId: null };
    const { fields } = broadcastToComposeFields(subscribersBroadcast);
    expect(fields.targetType).toBe('subscribers');
    expect(fields.targetChannelId).toBe('');
  });

  it('produces a fields object with no leftover keys beyond EMPTY_COMPOSE_FIELDS shape', () => {
    const { fields } = broadcastToComposeFields(baseBroadcast);
    expect(Object.keys(fields).sort()).toEqual(Object.keys(EMPTY_COMPOSE_FIELDS).sort());
  });
});

describe('isMediaUncopyable', () => {
  const withServerFile = { mediaFileId: 'file-abc-123', mediaServerFilename: 'broadcast-media-x.jpg', mediaUrl: null };
  const legacyFileIdOnly = { mediaFileId: 'file-abc-123', mediaServerFilename: null, mediaUrl: null };
  const legacyUrlOnly = { mediaFileId: null, mediaServerFilename: null, mediaUrl: 'https://old-cdn.example/image.jpg' };
  const noMedia = { mediaFileId: null, mediaServerFilename: null, mediaUrl: null };

  it('is copyable whenever a real server file exists — cross-bot no longer matters (prompt 0141)', () => {
    expect(isMediaUncopyable(withServerFile)).toBe(false);
  });

  it('is uncopyable for a real mediaFileId with no server file (pre-Stage-C legacy)', () => {
    expect(isMediaUncopyable(legacyFileIdOnly)).toBe(true);
  });

  it('is uncopyable for the oldest legacy shape (bare mediaUrl, no file_id, no server file)', () => {
    expect(isMediaUncopyable(legacyUrlOnly)).toBe(true);
  });

  it('is always copyable (nothing to skip) when there is no media at all', () => {
    expect(isMediaUncopyable(noMedia)).toBe(false);
  });
});

describe('mediaSkipReasonNote', () => {
  const withServerFile = { mediaFileId: 'file-abc-123', mediaServerFilename: 'broadcast-media-x.jpg', mediaUrl: null };
  const legacyFileIdOnly = { mediaFileId: 'file-abc-123', mediaServerFilename: null, mediaUrl: null };
  const noMedia = { mediaFileId: null, mediaServerFilename: null, mediaUrl: null };

  it('returns null when there is nothing to skip', () => {
    expect(mediaSkipReasonNote(noMedia)).toBeNull();
    expect(mediaSkipReasonNote(withServerFile)).toBeNull();
  });

  it('names the legacy reason plainly — never a generic "media skipped" label', () => {
    expect(mediaSkipReasonNote(legacyFileIdOnly)).toMatch(/broadcast lama/);
  });
});

describe('broadcastPlainTextExcerpt', () => {
  it('strips HTML tags and unescapes entities for an html-format body', () => {
    const excerpt = broadcastPlainTextExcerpt({
      bodyFormat: 'html',
      body: '<b>Hello</b> &amp; welcome — <a href="https://x.example">click here</a>'
    });
    expect(excerpt).toBe('Hello & welcome — click here');
  });

  it('passes a plain-format (legacy) body through untouched, aside from line-break collapsing', () => {
    const excerpt = broadcastPlainTextExcerpt({ bodyFormat: 'plain', body: 'Line one\nLine two' });
    expect(excerpt).toBe('Line one Line two');
  });

  it('truncates with an ellipsis past the max length, never mid-way through silently growing', () => {
    const longBody = 'a'.repeat(200);
    const excerpt = broadcastPlainTextExcerpt({ bodyFormat: 'plain', body: longBody }, 20);
    expect(excerpt.length).toBe(21); // 20 chars + the ellipsis character
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('returns an empty string for a missing/empty body rather than throwing', () => {
    expect(broadcastPlainTextExcerpt({ bodyFormat: 'plain', body: null })).toBe('');
    expect(broadcastPlainTextExcerpt({ bodyFormat: 'html', body: undefined })).toBe('');
  });
});
