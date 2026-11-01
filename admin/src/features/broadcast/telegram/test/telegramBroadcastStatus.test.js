import { describe, it, expect } from 'vitest';
import { recurringProgressLabel } from '../telegramBroadcastStatus.js';

describe('recurringProgressLabel', () => {
  it('returns null for a broadcast that was never recurring', () => {
    expect(recurringProgressLabel({ isRecurring: false, status: 'completed', sentCount: 3 })).toBeNull();
  });

  it('shows a placeholder while active but before the first round has recorded, naming the interval', () => {
    const label = recurringProgressLabel({
      isRecurring: true,
      status: 'recurring',
      sentCount: 0,
      recurringLastSentAt: null,
      recurringIntervalHours: 1
    });
    expect(label).toBe('Sent 0× — first send in progress, every 1 hour');
  });

  it('shows the running count + a non-empty last-sent time + the interval while active', () => {
    // The exact time format is locale-dependent (this environment renders
    // "17.30", others "5:30 PM", etc.) — assert the stable prefix/suffix
    // and that SOME time text is in between, rather than a specific
    // separator/format.
    const label = recurringProgressLabel({
      isRecurring: true,
      status: 'recurring',
      sentCount: 3,
      recurringLastSentAt: '2026-08-28T10:30:00.000Z',
      recurringIntervalHours: 2
    });
    expect(label.startsWith('Sent 3×, last ')).toBe(true);
    expect(label.endsWith(', every 2 hours')).toBe(true);
  });

  it('keeps reporting the final tally + interval after deactivation (status moved on from "recurring")', () => {
    const label = recurringProgressLabel({
      isRecurring: true,
      status: 'completed',
      sentCount: 7,
      recurringLastSentAt: '2026-08-28T11:00:00.000Z',
      recurringIntervalHours: 4
    });
    expect(label).toBe('Sent 7× total (auto, deactivated), every 4 hours');
  });

  it('treats a missing sentCount as zero rather than throwing or printing "undefined"', () => {
    const label = recurringProgressLabel({ isRecurring: true, status: 'recurring', recurringLastSentAt: null, recurringIntervalHours: 1 });
    expect(label).toBe('Sent 0× — first send in progress, every 1 hour');
  });

  it('defaults recurringIntervalHours to 1 hour when omitted', () => {
    const label = recurringProgressLabel({ isRecurring: true, status: 'recurring', sentCount: 0, recurringLastSentAt: null });
    expect(label).toBe('Sent 0× — first send in progress, every 1 hour');
  });

  // Prompt 0164 — a broadcast whose explicit "Mulai pada jam tertentu" start
  // time is still in the future gets its own distinct "not started yet"
  // wording, never the generic "first send in progress" text (which implies
  // an imminent send, not a still-pending scheduled start).
  it('shows "not started yet" + the start time when recurringStartsAt is still in the future', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const label = recurringProgressLabel({
      isRecurring: true,
      status: 'recurring',
      sentCount: 0,
      recurringLastSentAt: null,
      recurringStartsAt: future,
      recurringIntervalHours: 2
    });
    expect(label.startsWith('Not started yet — starts ')).toBe(true);
    expect(label.endsWith(', every 2 hours')).toBe(true);
  });

  it('falls back to the generic "first send in progress" wording once recurringStartsAt has already passed, even with no round recorded yet', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const label = recurringProgressLabel({
      isRecurring: true,
      status: 'recurring',
      sentCount: 0,
      recurringLastSentAt: null,
      recurringStartsAt: past,
      recurringIntervalHours: 1
    });
    expect(label).toBe('Sent 0× — first send in progress, every 1 hour');
  });

  it('never shows "not started yet" once a round has actually been recorded, regardless of recurringStartsAt', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const label = recurringProgressLabel({
      isRecurring: true,
      status: 'recurring',
      sentCount: 1,
      recurringLastSentAt: '2026-08-28T10:30:00.000Z',
      recurringStartsAt: future,
      recurringIntervalHours: 1
    });
    expect(label.startsWith('Sent 1×, last ')).toBe(true);
  });

  it('a 1-hour interval is singular ("hour"), every other value is plural ("hours")', () => {
    const oneHour = recurringProgressLabel({ isRecurring: true, status: 'completed', sentCount: 1, recurringIntervalHours: 1 });
    const twoHours = recurringProgressLabel({ isRecurring: true, status: 'completed', sentCount: 1, recurringIntervalHours: 2 });
    const twentyFourHours = recurringProgressLabel({ isRecurring: true, status: 'completed', sentCount: 1, recurringIntervalHours: 24 });
    expect(oneHour.endsWith('every 1 hour')).toBe(true);
    expect(twoHours.endsWith('every 2 hours')).toBe(true);
    expect(twentyFourHours.endsWith('every 24 hours')).toBe(true);
  });

  // Prompt 0166 — the most recent round's own delivered/failed counts,
  // once persisted (recurringLastRoundSentCount/recurringLastRoundFailedCount).
  describe('last-round result fragment', () => {
    it('shows "last round N of M delivered" while still active, all delivered', () => {
      const label = recurringProgressLabel({
        isRecurring: true,
        status: 'recurring',
        sentCount: 5,
        recurringLastSentAt: '2026-09-01T12:34:22.116Z',
        recurringIntervalHours: 1,
        recurringLastRoundSentCount: 3,
        recurringLastRoundFailedCount: 0
      });
      expect(label.includes('last round 3 of 3 delivered')).toBe(true);
    });

    it('shows a partial result (some failed) without hiding the failure', () => {
      const label = recurringProgressLabel({
        isRecurring: true,
        status: 'recurring',
        sentCount: 5,
        recurringLastSentAt: '2026-09-01T12:34:22.116Z',
        recurringIntervalHours: 1,
        recurringLastRoundSentCount: 2,
        recurringLastRoundFailedCount: 1
      });
      expect(label.includes('last round 2 of 3 delivered')).toBe(true);
    });

    it('shows the round result on a deactivated (auto, deactivated) broadcast too', () => {
      const label = recurringProgressLabel({
        isRecurring: true,
        status: 'completed',
        sentCount: 5,
        recurringIntervalHours: 1,
        recurringLastRoundSentCount: 3,
        recurringLastRoundFailedCount: 0
      });
      expect(label).toBe('Sent 5× total (auto, deactivated), every 1 hour, last round 3 of 3 delivered');
    });

    it('a legacy row with null round-result fields shows exactly the pre-0166 wording, no fragment at all', () => {
      const label = recurringProgressLabel({
        isRecurring: true,
        status: 'recurring',
        sentCount: 5,
        recurringLastSentAt: '2026-09-01T12:34:22.116Z',
        recurringIntervalHours: 1,
        recurringLastRoundSentCount: null,
        recurringLastRoundFailedCount: null
      });
      expect(label.includes('last round')).toBe(false);
      expect(label.endsWith(', every 1 hour')).toBe(true);
    });

    it('omitted round-result fields (undefined, same as a row from before this column existed) behave identically to explicit null', () => {
      const label = recurringProgressLabel({
        isRecurring: true,
        status: 'recurring',
        sentCount: 5,
        recurringLastSentAt: '2026-09-01T12:34:22.116Z',
        recurringIntervalHours: 1
      });
      expect(label.includes('last round')).toBe(false);
    });

    it('a fully-failed round (0 of N delivered) still shows the real numbers, not hidden', () => {
      const label = recurringProgressLabel({
        isRecurring: true,
        status: 'recurring',
        sentCount: 4,
        recurringLastSentAt: '2026-09-01T12:34:22.116Z',
        recurringIntervalHours: 1,
        recurringLastRoundSentCount: 0,
        recurringLastRoundFailedCount: 3
      });
      expect(label.includes('last round 0 of 3 delivered')).toBe(true);
    });

    it('contains no literal hyphen character anywhere, matching the base style note', () => {
      const label = recurringProgressLabel({
        isRecurring: true,
        status: 'recurring',
        sentCount: 5,
        recurringLastSentAt: '2026-09-01T12:34:22.116Z',
        recurringIntervalHours: 1,
        recurringLastRoundSentCount: 2,
        recurringLastRoundFailedCount: 1
      });
      expect(label.includes('-')).toBe(false);
    });
  });

  // Prompt 0234 (P4) — jadwal berikutnya + durasi putaran terakhir TERLIHAT.
  it('shows the next due round for an active recurring broadcast (0234 P4)', () => {
    const label = recurringProgressLabel({
      isRecurring: true,
      status: 'recurring',
      sentCount: 2,
      recurringLastSentAt: '2026-10-26T06:52:00.000Z',
      recurringIntervalHours: 6,
      recurringNextRoundAt: '2026-10-26T11:00:00.000Z'
    });
    expect(label.includes('next round ')).toBe(true);
  });

  it('shows the last round duration and counts from the rounds table (0234 P4)', () => {
    const label = recurringProgressLabel({
      isRecurring: true,
      status: 'recurring',
      sentCount: 3,
      recurringLastSentAt: '2026-10-26T06:52:00.000Z',
      recurringIntervalHours: 6,
      recurringLastRound: {
        roundNo: 3,
        startedAt: '2026-10-26T05:00:00.000Z',
        finishedAt: '2026-10-26T06:52:00.000Z',
        sentCount: 15046,
        failedCount: 0
      }
    });
    expect(label.includes('last round 1 h 52 m, 15046 of 15046')).toBe(true);
  });

  it('keeps every legacy label byte identical when the 0234 fields are absent (backward compatibility)', () => {
    const label = recurringProgressLabel({
      isRecurring: true,
      status: 'completed',
      sentCount: 7,
      recurringIntervalHours: 4
    });
    expect(label).toBe('Sent 7× total (auto, deactivated), every 4 hours');
  });
});
