import { describe, it, expect } from 'vitest';
import { mergeAnnouncementsCache } from '../shared/announcementsMerge.js';

const NOW = 1_800_000_000_000;

describe('mergeAnnouncementsCache — new announcements', () => {
  it('assigns firstSeenAt = now to an announcement not previously cached', () => {
    const result = mergeAnnouncementsCache({
      cached: [],
      fresh: [{ id: 'a1', title: 'Hello' }],
      readIds: [],
      now: NOW
    });
    expect(result.announcements).toEqual([{ id: 'a1', title: 'Hello', firstSeenAt: NOW }]);
  });
});

describe('mergeAnnouncementsCache — content refresh, firstSeenAt preserved', () => {
  it('preserves the original firstSeenAt for an id already in cache, even when now has advanced', () => {
    const result = mergeAnnouncementsCache({
      cached: [{ id: 'a1', title: 'Old title', firstSeenAt: 1000 }],
      fresh: [{ id: 'a1', title: 'Edited title' }],
      readIds: [],
      now: NOW
    });
    expect(result.announcements).toEqual([{ id: 'a1', title: 'Edited title', firstSeenAt: 1000 }]);
  });
});

describe('mergeAnnouncementsCache — dedupe and removal', () => {
  it('drops an id that was cached but is no longer in the fresh server result (unpublished/expired)', () => {
    const result = mergeAnnouncementsCache({
      cached: [
        { id: 'a1', title: 'Still active', firstSeenAt: 1000 },
        { id: 'a2', title: 'Unpublished since', firstSeenAt: 2000 }
      ],
      fresh: [{ id: 'a1', title: 'Still active' }],
      readIds: [],
      now: NOW
    });
    expect(result.announcements.map((a) => a.id)).toEqual(['a1']);
  });

  it('never duplicates an id — one entry per id in the merged result', () => {
    const result = mergeAnnouncementsCache({
      cached: [{ id: 'a1', title: 'v1', firstSeenAt: 1000 }],
      fresh: [{ id: 'a1', title: 'v2' }],
      readIds: [],
      now: NOW
    });
    expect(result.announcements).toHaveLength(1);
  });
});

describe('mergeAnnouncementsCache — readIds pruning', () => {
  it('keeps a readId whose announcement is still present', () => {
    const result = mergeAnnouncementsCache({
      cached: [{ id: 'a1', firstSeenAt: 1000 }],
      fresh: [{ id: 'a1' }],
      readIds: ['a1'],
      now: NOW
    });
    expect(result.readIds).toEqual(['a1']);
  });

  it('prunes a readId whose announcement disappeared from the fresh result', () => {
    const result = mergeAnnouncementsCache({
      cached: [{ id: 'a1', firstSeenAt: 1000 }],
      fresh: [],
      readIds: ['a1', 'a2'],
      now: NOW
    });
    expect(result.readIds).toEqual([]);
  });
});

describe('mergeAnnouncementsCache — defensive input handling', () => {
  it('treats non-array cached/fresh/readIds as empty rather than throwing', () => {
    const result = mergeAnnouncementsCache({ cached: null, fresh: null, readIds: null, now: NOW });
    expect(result).toEqual({ announcements: [], readIds: [] });
  });
});
