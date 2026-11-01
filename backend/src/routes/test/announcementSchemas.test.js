import { describe, it, expect } from 'vitest';
// Prompt 0167 — imports the schema module directly, never the route file:
// routes/adminAnnouncementsRoutes.js eagerly imports its controller, which
// eagerly imports its repo, which eagerly opens a real DatabaseSync
// connection at module load — exactly the accidental dev-DB-touching this
// restructuring exists to make impossible for a zod-only test like this one.
import { createSchema, updateSchema } from '../../schemas/announcementSchemas.js';

// Prompt 0163 — exported specifically so this can call .safeParse() directly
// rather than needing a full HTTP round trip, same reasoning as
// buttonSchemas.test.js's own broadcastButtonSchema/welcomeButtonSchema
// export.
describe('createSchema — format defaults', () => {
  it('defaults titleFormat/bodyFormat to plain when omitted', () => {
    const result = createSchema.safeParse({ title: 'Hi', body: 'Body' });
    expect(result.success).toBe(true);
    expect(result.data.titleFormat).toBe('plain');
    expect(result.data.bodyFormat).toBe('plain');
  });

  it('accepts an explicit html format', () => {
    const result = createSchema.safeParse({ title: 'Hi', body: 'Body', titleFormat: 'html', bodyFormat: 'html' });
    expect(result.success).toBe(true);
    expect(result.data.titleFormat).toBe('html');
  });

  it('rejects an invalid format value', () => {
    const result = createSchema.safeParse({ title: 'Hi', body: 'Body', titleFormat: 'markdown' });
    expect(result.success).toBe(false);
  });
});

describe('createSchema — HTML sanitization at write time', () => {
  it('sanitizes an html title down to the base whitelist', () => {
    const result = createSchema.safeParse({ title: '<b>Bold</b><script>evil()</script>', titleFormat: 'html', body: 'Body' });
    expect(result.success).toBe(true);
    expect(result.data.title).toBe('<b>Bold</b>');
  });

  it('never allows a <tg-emoji> tag through, even if a client sends one — announcements are not Telegram', () => {
    const result = createSchema.safeParse({
      title: 'Hi',
      body: '<tg-emoji emoji-id="123">⭐</tg-emoji> body',
      bodyFormat: 'html'
    });
    expect(result.success).toBe(true);
    expect(result.data.body).toBe('⭐ body');
  });

  it('rejects a non-https link in an html body with a clear error', () => {
    const result = createSchema.safeParse({
      title: 'Hi',
      body: '<a href="http://insecure.example">bad</a>',
      bodyFormat: 'html'
    });
    expect(result.success).toBe(false);
  });

  it('a plain-format title/body is never processed as HTML at all — literal < > survive untouched', () => {
    const result = createSchema.safeParse({ title: 'Sale <today>', body: 'Get it <now>' });
    expect(result.success).toBe(true);
    expect(result.data.title).toBe('Sale <today>');
    expect(result.data.body).toBe('Get it <now>');
  });
});

describe('createSchema — title length, measured on plain text after strip, loose raw cap', () => {
  it('accepts a plain title exactly 200 characters', () => {
    const result = createSchema.safeParse({ title: 'x'.repeat(200), body: 'Body' });
    expect(result.success).toBe(true);
  });

  it('rejects a plain title of 201 characters', () => {
    const result = createSchema.safeParse({ title: 'x'.repeat(201), body: 'Body' });
    expect(result.success).toBe(false);
  });

  it('accepts an html title whose RAW string exceeds 200 chars but whose PLAIN TEXT is exactly 200', () => {
    const visible = 'y'.repeat(200);
    const result = createSchema.safeParse({ title: `<b>${visible}</b>`, titleFormat: 'html', body: 'Body' });
    expect(result.success).toBe(true);
  });

  it('rejects an html title whose plain text is 201 characters, even though the tags keep it "short" in a naive raw check', () => {
    const visible = 'y'.repeat(201);
    const result = createSchema.safeParse({ title: `<b>${visible}</b>`, titleFormat: 'html', body: 'Body' });
    expect(result.success).toBe(false);
  });

  it('rejects a raw title string over the loose 1000-char sanity cap outright', () => {
    const result = createSchema.safeParse({ title: 'x'.repeat(1001), body: 'Body' });
    expect(result.success).toBe(false);
  });
});

// Prompt 0172 — 'mobile' added alongside the project's pre-existing
// web/extension/all vocabulary (backend migration 0025 widens the
// matching target_platform CHECK constraint the same way).
describe('createSchema — targetPlatform', () => {
  it('defaults to "all" when omitted', () => {
    const result = createSchema.safeParse({ title: 'Hi', body: 'Body' });
    expect(result.success).toBe(true);
    expect(result.data.targetPlatform).toBe('all');
  });

  it.each(['web', 'extension', 'mobile', 'all'])('accepts %s as a valid targetPlatform', (value) => {
    const result = createSchema.safeParse({ title: 'Hi', body: 'Body', targetPlatform: value });
    expect(result.success).toBe(true);
    expect(result.data.targetPlatform).toBe(value);
  });

  it('rejects a targetPlatform value outside the enum', () => {
    const result = createSchema.safeParse({ title: 'Hi', body: 'Body', targetPlatform: 'desktop' });
    expect(result.success).toBe(false);
  });
});

describe('updateSchema — partial updates', () => {
  it('accepts a partial update touching only level, leaving format fields genuinely absent (not defaulted to plain)', () => {
    const result = updateSchema.safeParse({ level: 'critical' });
    expect(result.success).toBe(true);
    expect('titleFormat' in result.data).toBe(false);
    expect('bodyFormat' in result.data).toBe(false);
    expect('title' in result.data).toBe(false);
  });

  it('skips the title-length check entirely when title is not part of this update', () => {
    const result = updateSchema.safeParse({ targetPlatform: 'web' });
    expect(result.success).toBe(true);
  });

  it('still enforces the 200-char plain-text limit when title IS part of the update', () => {
    const result = updateSchema.safeParse({ title: 'x'.repeat(201) });
    expect(result.success).toBe(false);
  });

  it('sanitizes an html body when body/bodyFormat are both part of this update', () => {
    const result = updateSchema.safeParse({ body: '<b>Bold</b><script>evil()</script>', bodyFormat: 'html' });
    expect(result.success).toBe(true);
    expect(result.data.body).toBe('<b>Bold</b>');
  });
});
