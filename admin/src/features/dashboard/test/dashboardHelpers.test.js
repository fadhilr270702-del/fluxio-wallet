import { describe, it, expect } from 'vitest';
import { buildOtherBotPill, newSubscribersDeltaHint } from '../dashboardHelpers.js';

describe('buildOtherBotPill', () => {
  it('returns the { label, count } shape StatTile renders as the other bot pill', () => {
    expect(buildOtherBotPill('Bot Resmi', 2, false)).toEqual({ label: 'Bot Resmi', count: 2 });
  });

  it('passes the loading placeholder through once the caller resolves it to "—"', () => {
    expect(buildOtherBotPill('Bot Resmi', '—', false)).toEqual({ label: 'Bot Resmi', count: '—' });
  });

  it('returns null on a failed fetch — never a misleading placeholder dressed up as real data', () => {
    expect(buildOtherBotPill('Bot Resmi', '—', true)).toBeNull();
  });

  it('works for either bot as "the other one", not hardcoded to official', () => {
    expect(buildOtherBotPill('Bot Percobaan', 5, false)).toEqual({ label: 'Bot Percobaan', count: 5 });
  });

  it('returns null on error even when a stale count value is around', () => {
    expect(buildOtherBotPill('Bot Percobaan', 5, true)).toBeNull();
  });
});
// Prompt 0235 — the New subscribers (7 days) delta hint.
describe('newSubscribersDeltaHint', () => {
  it('formats positive, negative, and zero deltas without any hyphen prose', () => {
    expect(newSubscribersDeltaHint(120, 80)).toBe('+40 vs previous 7 days');
    expect(newSubscribersDeltaHint(80, 120)).toBe('-40 vs previous 7 days');
    expect(newSubscribersDeltaHint(5, 5)).toBe('Same as previous 7 days');
  });

  it('degrades to the plain window label while data is missing (older backend or loading)', () => {
    expect(newSubscribersDeltaHint(undefined, 5)).toBe('Last 7 days');
    expect(newSubscribersDeltaHint(5, null)).toBe('Last 7 days');
  });
});

