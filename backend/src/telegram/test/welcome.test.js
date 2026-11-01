import { describe, it, expect } from 'vitest';
import {
  shouldSendWelcome,
  buildWelcomeMessage,
  isValidUploadedMediaFilename,
  mediaTypeForFilename,
  selectOrphanedFiles,
  shouldSendAsMedia
} from '../welcome.js';

// Prompt 0135 — the dedup decision behind the /start welcome reply is pure
// (no I/O), so it gets the same direct unit-test treatment prompt 0134
// Revision 1 gave isRecurringDue().
describe('shouldSendWelcome', () => {
  it('sends when the subscriber has never been welcomed (null)', () => {
    expect(shouldSendWelcome(null, 100)).toBe(true);
  });

  it('sends when the subscriber has never been welcomed (undefined)', () => {
    expect(shouldSendWelcome(undefined, 100)).toBe(true);
  });

  it('does NOT send for a re-processed update this chat was already welcomed for', () => {
    expect(shouldSendWelcome(100, 100)).toBe(false);
  });

  it('does NOT send for an update older than the last welcome (out-of-order replay)', () => {
    expect(shouldSendWelcome(100, 50)).toBe(false);
  });

  it('sends for a genuinely newer update_id (a real later /start)', () => {
    expect(shouldSendWelcome(100, 101)).toBe(true);
  });

  it('sends for a much later update_id (e.g. delete-chat-then-/start-again, long afterward)', () => {
    expect(shouldSendWelcome(100, 9999)).toBe(true);
  });
});

// Prompt 0136 — plain vs. HTML text-building for the admin-editable
// welcome config (no title concatenation, unlike buildBroadcastMessage).
describe('buildWelcomeMessage', () => {
  it('sends plain text with no parse_mode for a plain-format config', () => {
    const result = buildWelcomeMessage({ body: 'Hello & welcome', bodyFormat: 'plain' });
    expect(result).toEqual({ text: 'Hello & welcome', parseMode: undefined });
  });

  it('sanitizes and sends Telegram-HTML with parse_mode HTML for an html-format config', () => {
    // sanitize-html's default behavior for a disallowed tag like <script>
    // is to drop the tag AND its contents entirely (never surface the
    // script's own text as if it were safe visible content) — this
    // confirms that, not just that <b> survives.
    const result = buildWelcomeMessage({ body: '<b>Hello</b> <script>alert(1)</script>', bodyFormat: 'html' });
    expect(result.parseMode).toBe('HTML');
    expect(result.text).toBe('<b>Hello</b> ');
    expect(result.text).not.toContain('alert(1)');
    expect(result.text).not.toContain('<script>');
  });

  it('strips a non-https link when sanitizing html body', () => {
    const result = buildWelcomeMessage({ body: '<a href="javascript:alert(1)">click</a>', bodyFormat: 'html' });
    expect(result.text).not.toContain('javascript:');
  });
});

// Prompt 0137 — renamed from isValidUploadedImageFilename (0136) now that
// uploads can be a video too, and the accepted shape changed from one
// fixed name to a per-upload UUID pattern (0136's single shared-slot
// filename rotted an old version's own reference the moment it was
// replaced — see welcome.js's own header comment). This is the ONLY thing
// that makes it safe to trust a client-echoed imageFilename in the PUT
// payload (see welcomeController.js's update()); a filename not matching
// one of the two allowed shapes can never reference anything outside
// backend/uploads/.
//
// Prompt 0138 (dual-bot foundation) — the filename itself now embeds which
// bot it belongs to (`welcome-media-<bot>-<uuid>.<ext>`), and this function
// takes the CALLING bot's own id as a second argument, returning true only
// when the filename's embedded bot matches it. Every pre-existing case
// below was updated to pass a bot id and use bot-tagged fixtures; new cases
// were added specifically for the cross-bot rejection this prompt's own
// verification requirement asked for.
describe('isValidUploadedMediaFilename', () => {
  it('accepts the exact per-upload filenames saveUploadedMedia() can produce for that same bot, for every supported extension', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    expect(isValidUploadedMediaFilename(`welcome-media-test-${uuid}.jpg`, 'test')).toBe(true);
    expect(isValidUploadedMediaFilename(`welcome-media-test-${uuid}.jpeg`, 'test')).toBe(true);
    expect(isValidUploadedMediaFilename(`welcome-media-test-${uuid}.png`, 'test')).toBe(true);
    expect(isValidUploadedMediaFilename(`welcome-media-test-${uuid}.webp`, 'test')).toBe(true);
    expect(isValidUploadedMediaFilename(`welcome-media-test-${uuid}.mp4`, 'test')).toBe(true);
    expect(isValidUploadedMediaFilename(`welcome-media-official-${uuid}.png`, 'official')).toBe(true);
  });

  it('accepts the one legacy filename migrateLegacyBannerIfNeeded() can produce, but ONLY for the trial bot', () => {
    expect(isValidUploadedMediaFilename('welcome-image.png', 'test')).toBe(true);
  });

  it('rejects the legacy filename for a non-trial bot (there is no equivalent legacy asset for it)', () => {
    expect(isValidUploadedMediaFilename('welcome-image.png', 'official')).toBe(false);
  });

  it('rejects a filename that belongs to a DIFFERENT bot than the one asking (cross-bot isolation)', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    expect(isValidUploadedMediaFilename(`welcome-media-test-${uuid}.png`, 'official')).toBe(false);
    expect(isValidUploadedMediaFilename(`welcome-media-official-${uuid}.png`, 'test')).toBe(false);
  });

  it('rejects a path-traversal attempt', () => {
    expect(isValidUploadedMediaFilename('../../etc/passwd', 'test')).toBe(false);
  });

  it('rejects an absolute path', () => {
    expect(isValidUploadedMediaFilename('/etc/passwd', 'test')).toBe(false);
  });

  it('rejects a malformed/non-UUID id even with a valid extension', () => {
    expect(isValidUploadedMediaFilename('welcome-media-test-not-a-real-uuid.png', 'test')).toBe(false);
  });

  it('rejects a disallowed extension on an otherwise-valid UUID filename', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    expect(isValidUploadedMediaFilename(`welcome-media-test-${uuid}.gif`, 'test')).toBe(false);
    expect(isValidUploadedMediaFilename(`welcome-media-test-${uuid}.svg`, 'test')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isValidUploadedMediaFilename(null, 'test')).toBe(false);
    expect(isValidUploadedMediaFilename(undefined, 'test')).toBe(false);
  });
});

// Prompt 0137 — this is what makes image/video mutual exclusivity
// structural rather than a separate rule to maintain: a filename maps to
// exactly one media type, so there's no way to represent "both" or
// "neither is clear" in the stored data at all.
describe('mediaTypeForFilename', () => {
  it('resolves every image extension to "image"', () => {
    expect(mediaTypeForFilename('welcome-media-x.jpg')).toBe('image');
    expect(mediaTypeForFilename('welcome-media-x.jpeg')).toBe('image');
    expect(mediaTypeForFilename('welcome-media-x.png')).toBe('image');
    expect(mediaTypeForFilename('welcome-media-x.webp')).toBe('image');
  });

  it('resolves .mp4 to "video"', () => {
    expect(mediaTypeForFilename('welcome-media-x.mp4')).toBe('video');
  });

  it('resolves the legacy filename to "image"', () => {
    expect(mediaTypeForFilename('welcome-image.png')).toBe('image');
  });

  it('returns null for an unrecognized extension or empty input', () => {
    expect(mediaTypeForFilename('welcome-media-x.gif')).toBe(null);
    expect(mediaTypeForFilename('')).toBe(null);
    expect(mediaTypeForFilename(null)).toBe(null);
  });
});

// Prompt 0137 — the pruning decision: given what a retention pass is about
// to delete and what's still referenced by anything surviving, which files
// are actually safe to remove. This is the core of the "don't delete a
// file a surviving version or the active config still needs" requirement —
// see welcomeController.js's update() for the real ordering (versions
// deleted from the DB FIRST, then this runs against the post-deletion
// state) this function itself doesn't enforce, since it's pure and has no
// idea what order its caller used.
describe('selectOrphanedFiles', () => {
  it('returns a candidate that is referenced by nothing else', () => {
    expect(selectOrphanedFiles(['a.png'], ['b.png', 'c.png'])).toEqual(['a.png']);
  });

  it('excludes a candidate still referenced by the active config or a surviving version', () => {
    expect(selectOrphanedFiles(['a.png', 'b.png'], ['b.png'])).toEqual(['a.png']);
  });

  it('returns nothing when every candidate is still referenced', () => {
    expect(selectOrphanedFiles(['a.png', 'b.png'], ['a.png', 'b.png'])).toEqual([]);
  });

  it('de-duplicates repeated candidates', () => {
    expect(selectOrphanedFiles(['a.png', 'a.png'], [])).toEqual(['a.png']);
  });

  it('ignores null/undefined entries in both lists (a version with no media at all)', () => {
    expect(selectOrphanedFiles([null, 'a.png'], [undefined, 'b.png'])).toEqual(['a.png']);
  });

  it('returns an empty array for an empty candidate list', () => {
    expect(selectOrphanedFiles([], ['a.png'])).toEqual([]);
  });

  // Prompt 0138 — this function itself stays bot-agnostic (pure, no notion
  // of "bot" at all — see its own updated header comment); what actually
  // makes pruning bot-safe is that its CALLER (welcomeController.js's
  // update()) now always builds both the candidate and still-referenced
  // lists from the SAME bot's own scoped repo queries. This test proves
  // the one thing that would matter if that discipline were ever violated:
  // even if a bot-A candidate and a bot-B "still referenced" filename
  // happened to collide, cross-bot filenames can never actually collide in
  // practice, because every real filename now embeds its own bot id (see
  // saveUploadedMedia()) — so two different bots' uploads are always
  // distinct strings here, and neither can ever accidentally "protect" the
  // other's file from deletion or vice versa.
  it('never treats a differently-bot-tagged filename as protecting another bot\'s candidate (filenames embed their own bot id, so they cannot collide)', () => {
    const botATestCandidate = 'welcome-media-test-123e4567-e89b-12d3-a456-426614174000.png';
    const botOfficialStillReferenced = 'welcome-media-official-123e4567-e89b-12d3-a456-426614174000.png';
    expect(selectOrphanedFiles([botATestCandidate], [botOfficialStillReferenced])).toEqual([botATestCandidate]);
  });
});

// Prompt 0137 — the send-mode decision, with the missing-file existence
// check dependency-injected as a plain boolean so this stays pure and
// directly testable (the real existsSync() call lives only in the caller,
// sendWelcomeMessage()).
describe('shouldSendAsMedia', () => {
  it('sends as media when a path, a media type, and file existence are all present', () => {
    expect(shouldSendAsMedia('/uploads/x.png', 'image', true)).toBe(true);
  });

  it('falls back to text when there is no media configured at all', () => {
    expect(shouldSendAsMedia(null, null, false)).toBe(false);
  });

  it('falls back to text when the file has gone missing (prompt 0137\'s own explicit requirement)', () => {
    expect(shouldSendAsMedia('/uploads/x.png', 'image', false)).toBe(false);
  });

  it('falls back to text when mediaType is missing even though a path is set', () => {
    expect(shouldSendAsMedia('/uploads/x.png', null, true)).toBe(false);
  });
});
