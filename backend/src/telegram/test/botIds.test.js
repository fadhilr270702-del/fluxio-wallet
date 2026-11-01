import { describe, it, expect } from 'vitest';
import { BOT_IDS, DEFAULT_BOT_ID, isValidBotId, otherBotId } from '../botIds.js';

// Prompt 0138 (dual-bot foundation) — this enum is the one thing every
// other bot-scoped piece of this arc (env.js, resolveBotId.js, every
// repository/controller) trusts without re-validating, so it gets its own
// direct test coverage.
describe('botIds', () => {
  it('exposes exactly the two known bot ids', () => {
    expect(BOT_IDS).toEqual(['test', 'official']);
  });

  it('defaults to the trial bot — the one every pre-0138 row and every unmodified admin-UI request implicitly means', () => {
    expect(DEFAULT_BOT_ID).toBe('test');
  });

  it('accepts every real bot id', () => {
    expect(isValidBotId('test')).toBe(true);
    expect(isValidBotId('official')).toBe(true);
  });

  it('rejects an unknown string', () => {
    expect(isValidBotId('production')).toBe(false);
    expect(isValidBotId('Test')).toBe(false); // case-sensitive — no normalization
  });

  it('rejects non-string/empty input', () => {
    expect(isValidBotId('')).toBe(false);
    expect(isValidBotId(null)).toBe(false);
    expect(isValidBotId(undefined)).toBe(false);
  });
});

// Prompt 0141 — otherBotId() is what "Salin ke bot lain" (welcome) uses to
// derive its always-implicit target; getting this backwards would silently
// copy a bot's config onto itself instead of the other one.
describe('otherBotId', () => {
  it('returns official for test', () => {
    expect(otherBotId('test')).toBe('official');
  });

  it('returns test for official', () => {
    expect(otherBotId('official')).toBe('test');
  });

  it('is its own inverse — applying it twice returns the original bot', () => {
    for (const id of BOT_IDS) {
      expect(otherBotId(otherBotId(id))).toBe(id);
    }
  });
});
