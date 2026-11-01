import { describe, it, expect } from 'vitest';
// Prompt 0167 — imports the schema module directly, never the route file —
// see announcementSchemas.test.js's own updated comment for why.
import { updateVersionSchema } from '../../schemas/versionSchemas.js';

const base = { latestVersion: '1.2.0', minSupportedVersion: '1.0.0' };

describe('updateVersionSchema — format defaults', () => {
  it('defaults updateMessageFormat to plain when omitted', () => {
    const result = updateVersionSchema.safeParse(base);
    expect(result.success).toBe(true);
    expect(result.data.updateMessageFormat).toBe('plain');
  });

  it('accepts an explicit html format', () => {
    const result = updateVersionSchema.safeParse({ ...base, updateMessage: '<b>New</b>', updateMessageFormat: 'html' });
    expect(result.success).toBe(true);
    expect(result.data.updateMessage).toBe('<b>New</b>');
  });
});

describe('updateVersionSchema — HTML sanitization at write time', () => {
  it('sanitizes an html update message down to the base whitelist', () => {
    const result = updateVersionSchema.safeParse({ ...base, updateMessage: '<b>Bold</b><script>evil()</script>', updateMessageFormat: 'html' });
    expect(result.success).toBe(true);
    expect(result.data.updateMessage).toBe('<b>Bold</b>');
  });

  it('never allows a <tg-emoji> tag through — versions are not Telegram either', () => {
    const result = updateVersionSchema.safeParse({ ...base, updateMessage: '<tg-emoji emoji-id="1">⭐</tg-emoji>', updateMessageFormat: 'html' });
    expect(result.success).toBe(true);
    expect(result.data.updateMessage).toBe('⭐');
  });

  it('rejects a non-https link in an html update message', () => {
    const result = updateVersionSchema.safeParse({ ...base, updateMessage: '<a href="http://insecure.example">bad</a>', updateMessageFormat: 'html' });
    expect(result.success).toBe(false);
  });

  it('a plain-format update message is never processed as HTML — literal < > survive untouched', () => {
    const result = updateVersionSchema.safeParse({ ...base, updateMessage: 'See <details>' });
    expect(result.success).toBe(true);
    expect(result.data.updateMessage).toBe('See <details>');
  });
});

describe('updateVersionSchema — update message length, measured on plain text after strip, loose raw cap', () => {
  it('accepts a plain update message exactly 500 characters', () => {
    const result = updateVersionSchema.safeParse({ ...base, updateMessage: 'x'.repeat(500) });
    expect(result.success).toBe(true);
  });

  it('rejects a plain update message of 501 characters', () => {
    const result = updateVersionSchema.safeParse({ ...base, updateMessage: 'x'.repeat(501) });
    expect(result.success).toBe(false);
  });

  it('accepts an html message whose RAW string exceeds 500 but whose PLAIN TEXT is exactly 500', () => {
    const visible = 'y'.repeat(500);
    const result = updateVersionSchema.safeParse({ ...base, updateMessage: `<b>${visible}</b>`, updateMessageFormat: 'html' });
    expect(result.success).toBe(true);
  });

  it('rejects an html message whose plain text is 501 characters', () => {
    const visible = 'y'.repeat(501);
    const result = updateVersionSchema.safeParse({ ...base, updateMessage: `<b>${visible}</b>`, updateMessageFormat: 'html' });
    expect(result.success).toBe(false);
  });

  it('an absent/null update message is always fine regardless of format (nothing to measure)', () => {
    const result = updateVersionSchema.safeParse(base);
    expect(result.success).toBe(true);
  });
});

describe('updateVersionSchema — existing rules preserved (regression)', () => {
  it('still rejects latestVersion < minSupportedVersion', () => {
    const result = updateVersionSchema.safeParse({ latestVersion: '1.0.0', minSupportedVersion: '1.2.0' });
    expect(result.success).toBe(false);
  });

  it('still requires X.Y.Z version format', () => {
    const result = updateVersionSchema.safeParse({ latestVersion: '1.2', minSupportedVersion: '1.0.0' });
    expect(result.success).toBe(false);
  });
});
