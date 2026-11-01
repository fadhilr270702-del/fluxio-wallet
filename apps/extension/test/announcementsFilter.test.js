import { describe, it, expect } from 'vitest';
import { filterAnnouncementsForPlatform } from '../shared/announcementsFilter.js';

const NOW = new Date('2026-06-15T12:00:00.000Z').getTime();

function row(overrides = {}) {
  return {
    id: 'a1',
    targetPlatform: 'extension',
    startsAt: null,
    endsAt: null,
    ...overrides
  };
}

describe('filterAnnouncementsForPlatform — platform matching', () => {
  it('keeps a row targeted exactly at the given platform', () => {
    const result = filterAnnouncementsForPlatform([row({ targetPlatform: 'extension' })], { platform: 'extension', now: NOW });
    expect(result).toHaveLength(1);
  });

  it('keeps a row targeted at "all"', () => {
    const result = filterAnnouncementsForPlatform([row({ targetPlatform: 'all' })], { platform: 'extension', now: NOW });
    expect(result).toHaveLength(1);
  });

  it('drops a row targeted at a different platform', () => {
    const result = filterAnnouncementsForPlatform([row({ targetPlatform: 'web' })], { platform: 'extension', now: NOW });
    expect(result).toHaveLength(0);
  });

  // Prompt 0172 — 'mobile' is a new valid targetPlatform value (backend
  // migration 0025) alongside web/extension/all; this function itself
  // needed no code change (it was already generic over any platform
  // string), but the case was previously untested.
  it('drops a row targeted at "mobile" when this consumer is "extension"', () => {
    const result = filterAnnouncementsForPlatform([row({ targetPlatform: 'mobile' })], { platform: 'extension', now: NOW });
    expect(result).toHaveLength(0);
  });
});

describe('filterAnnouncementsForPlatform — active time window', () => {
  it('keeps a row with no startsAt/endsAt at all (always active)', () => {
    const result = filterAnnouncementsForPlatform([row({ startsAt: null, endsAt: null })], { platform: 'extension', now: NOW });
    expect(result).toHaveLength(1);
  });

  it('drops a row whose startsAt is in the future', () => {
    const result = filterAnnouncementsForPlatform([row({ startsAt: '2026-06-16T00:00:00.000Z' })], { platform: 'extension', now: NOW });
    expect(result).toHaveLength(0);
  });

  it('drops a row whose endsAt is in the past', () => {
    const result = filterAnnouncementsForPlatform([row({ endsAt: '2026-06-14T00:00:00.000Z' })], { platform: 'extension', now: NOW });
    expect(result).toHaveLength(0);
  });

  it('keeps a row whose window currently contains now', () => {
    const result = filterAnnouncementsForPlatform(
      [row({ startsAt: '2026-06-01T00:00:00.000Z', endsAt: '2026-06-30T00:00:00.000Z' })],
      { platform: 'extension', now: NOW }
    );
    expect(result).toHaveLength(1);
  });

  it('keeps a row exactly at its startsAt boundary (inclusive)', () => {
    const result = filterAnnouncementsForPlatform([row({ startsAt: new Date(NOW).toISOString() })], { platform: 'extension', now: NOW });
    expect(result).toHaveLength(1);
  });

  it('keeps a row exactly at its endsAt boundary (inclusive)', () => {
    const result = filterAnnouncementsForPlatform([row({ endsAt: new Date(NOW).toISOString() })], { platform: 'extension', now: NOW });
    expect(result).toHaveLength(1);
  });
});

describe('filterAnnouncementsForPlatform — defensive input handling', () => {
  it('returns an empty array for non-array input rather than throwing', () => {
    expect(filterAnnouncementsForPlatform(null, { platform: 'extension', now: NOW })).toEqual([]);
    expect(filterAnnouncementsForPlatform(undefined, { platform: 'extension', now: NOW })).toEqual([]);
  });

  it('combines platform and window filters — must pass both', () => {
    const rows = [
      row({ id: 'match', targetPlatform: 'extension', startsAt: null, endsAt: null }),
      row({ id: 'wrong-platform', targetPlatform: 'web', startsAt: null, endsAt: null }),
      row({ id: 'expired', targetPlatform: 'all', endsAt: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'not-yet', targetPlatform: 'all', startsAt: '2027-01-01T00:00:00.000Z' })
    ];
    const result = filterAnnouncementsForPlatform(rows, { platform: 'extension', now: NOW });
    expect(result.map((r) => r.id)).toEqual(['match']);
  });
});
