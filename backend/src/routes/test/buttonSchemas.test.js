import { describe, it, expect } from 'vitest';
// Prompt 0167 — imports the schema modules directly, never the route files
// — see announcementSchemas.test.js's own updated comment for why.
import { broadcastButtonSchema } from '../../schemas/telegramBroadcastSchemas.js';
import { welcomeButtonSchema } from '../../schemas/welcomeSchemas.js';

// Prompt 0153 — iconCustomEmojiId, the one new field on both button
// schemas. Both are exported specifically so this can call .safeParse()
// directly rather than needing a full HTTP round trip — the schemas
// themselves have no other test coverage convention in this codebase to
// deviate from by doing so (route validation elsewhere is otherwise only
// exercised live).
describe.each([
  ['broadcastButtonSchema', broadcastButtonSchema],
  ['welcomeButtonSchema', welcomeButtonSchema]
])('%s — iconCustomEmojiId', (_name, schema) => {
  const base = { text: 'Open', url: 'https://example.com' };

  it('accepts a button with no iconCustomEmojiId at all (pre-0153 shape, unchanged)', () => {
    const result = schema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it('accepts a valid digits-only iconCustomEmojiId', () => {
    const result = schema.safeParse({ ...base, iconCustomEmojiId: '5267500801240092311' });
    expect(result.success).toBe(true);
    expect(result.data.iconCustomEmojiId).toBe('5267500801240092311');
  });

  it('accepts an explicit null iconCustomEmojiId (nullish)', () => {
    const result = schema.safeParse({ ...base, iconCustomEmojiId: null });
    expect(result.success).toBe(true);
  });

  it('rejects an iconCustomEmojiId containing letters', () => {
    const result = schema.safeParse({ ...base, iconCustomEmojiId: 'abc123' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty-string iconCustomEmojiId', () => {
    const result = schema.safeParse({ ...base, iconCustomEmojiId: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an iconCustomEmojiId longer than 32 digits', () => {
    const result = schema.safeParse({ ...base, iconCustomEmojiId: '1'.repeat(33) });
    expect(result.success).toBe(false);
  });

  it('accepts an iconCustomEmojiId exactly 32 digits long', () => {
    const result = schema.safeParse({ ...base, iconCustomEmojiId: '1'.repeat(32) });
    expect(result.success).toBe(true);
  });

  it('still rejects a malformed button (missing url) regardless of iconCustomEmojiId', () => {
    const result = schema.safeParse({ text: 'Open', iconCustomEmojiId: '123' });
    expect(result.success).toBe(false);
  });
});
