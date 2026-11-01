import { describe, it, expect } from 'vitest';
import { topSource, subscribersBySourceItems } from '../analyticsHelpers.js';

// Prompt 0235 — the rows mirror the real summary shape (0233's
// telegramSubscribersBySource), including the real campaign label.
const ROWS = [
  { botId: 'official', source: null, count: 15046 },
  { botId: 'official', source: 'ads_2026_10_a', count: 1 },
  { botId: 'test', source: null, count: 3 }
];

describe('topSource', () => {
  it('picks the highest-count ATTRIBUTED source, never organic', () => {
    expect(topSource(ROWS)).toEqual({ botId: 'official', source: 'ads_2026_10_a', count: 1 });
  });

  it('returns null when nothing is attributed yet (organic only, empty, or missing)', () => {
    expect(topSource([{ botId: 'official', source: null, count: 10 }])).toBe(null);
    expect(topSource([])).toBe(null);
    expect(topSource(undefined)).toBe(null);
  });

  it('prefers the larger campaign when several are attributed', () => {
    const rows = [...ROWS, { botId: 'official', source: 'ads_2026_11_b', count: 7 }];
    expect(topSource(rows).source).toBe('ads_2026_11_b');
  });
});

describe('subscribersBySourceItems', () => {
  it('keeps the source label VERBATIM (no capitalization — the 0233 cosmetic note) and suffixes trial-bot rows', () => {
    const items = subscribersBySourceItems(ROWS);
    expect(items).toEqual([
      { key: 'official:organic', label: 'organic', count: 15046 },
      { key: 'official:ads_2026_10_a', label: 'ads_2026_10_a', count: 1 },
      { key: 'test:organic', label: 'organic (test bot)', count: 3 }
    ]);
  });

  it('handles a missing rows array', () => {
    expect(subscribersBySourceItems(undefined)).toEqual([]);
  });
});
