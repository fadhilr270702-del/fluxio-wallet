import { describe, it, expect } from 'vitest';
import { resolveBotId } from '../resolveBotId.js';
import { HttpError } from '../../utils/httpError.js';

// Prompt 0138 (dual-bot foundation) — the shared "missing = default 'test',
// invalid = clean 400" contract every bot-context-accepting endpoint
// (broadcast status/list/create/uploads, welcome get/update/uploads/media/
// versions) relies on. This is what keeps the CURRENT, unmodified admin UI
// (which never sends a `bot` param) behaving byte-for-byte as it did before
// this prompt existed, while still closing off a typo'd/forged bot id.
describe('resolveBotId', () => {
  it('defaults to the trial bot when no value is given (undefined) — the unmodified admin UI\'s own request shape', () => {
    expect(resolveBotId(undefined)).toBe('test');
  });

  it('defaults to the trial bot for null', () => {
    expect(resolveBotId(null)).toBe('test');
  });

  it('defaults to the trial bot for an empty string', () => {
    expect(resolveBotId('')).toBe('test');
  });

  it('accepts an explicit "test"', () => {
    expect(resolveBotId('test')).toBe('test');
  });

  it('accepts an explicit "official"', () => {
    expect(resolveBotId('official')).toBe('official');
  });

  it('throws a clean 400 HttpError with a dedicated code for an unknown bot id — never silently falls back to the default', () => {
    let caught;
    try {
      resolveBotId('production');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught.status).toBe(400);
    expect(caught.code).toBe('INVALID_BOT_ID');
  });

  it('throws for a case-mismatched value rather than normalizing it', () => {
    expect(() => resolveBotId('Test')).toThrow(HttpError);
  });
});
