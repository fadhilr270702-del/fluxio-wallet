import { describe, it, expect } from 'vitest';
import { shouldAutoLock, AUTO_LOCK_NEVER, AUTO_LOCK_OPTIONS_MINUTES, AUTO_LOCK_DEFAULT_MINUTES } from '../shared/autoLockDecision.js';

const NOW = 1_800_000_000_000; // an arbitrary fixed epoch-ms instant

describe('shouldAutoLock — prompt 0117', () => {
  it('does not lock when elapsed time is well under the configured duration', () => {
    const lastActivityAt = NOW - 5 * 60_000; // 5 minutes ago
    expect(shouldAutoLock({ now: NOW, lastActivityAt, durationMinutes: 15 })).toBe(false);
  });

  it('locks exactly at the boundary (elapsed === duration), inclusive', () => {
    const lastActivityAt = NOW - 15 * 60_000; // exactly 15 minutes ago
    expect(shouldAutoLock({ now: NOW, lastActivityAt, durationMinutes: 15 })).toBe(true);
  });

  it('does not lock one millisecond before the boundary', () => {
    const lastActivityAt = NOW - 15 * 60_000 + 1;
    expect(shouldAutoLock({ now: NOW, lastActivityAt, durationMinutes: 15 })).toBe(false);
  });

  it('locks well past the boundary', () => {
    const lastActivityAt = NOW - 60 * 60_000; // 1 hour ago, 15-minute setting
    expect(shouldAutoLock({ now: NOW, lastActivityAt, durationMinutes: 15 })).toBe(true);
  });

  it('never locks when the setting is AUTO_LOCK_NEVER, no matter how long has elapsed', () => {
    const lastActivityAt = NOW - 10 * 60 * 60_000; // 10 hours ago
    expect(shouldAutoLock({ now: NOW, lastActivityAt, durationMinutes: AUTO_LOCK_NEVER })).toBe(false);
  });

  it('honors AUTO_LOCK_NEVER even when the activity timestamp is missing/corrupt — an explicit opt-out is never overridden by bad data', () => {
    expect(shouldAutoLock({ now: NOW, lastActivityAt: undefined, durationMinutes: AUTO_LOCK_NEVER })).toBe(false);
    expect(shouldAutoLock({ now: NOW, lastActivityAt: NaN, durationMinutes: AUTO_LOCK_NEVER })).toBe(false);
  });

  it.each([undefined, null, NaN, 'not-a-number', Infinity, -Infinity])(
    'fails CLOSED (locks) when lastActivityAt is missing/corrupt (%s) and a real duration is configured',
    (badTimestamp) => {
      expect(shouldAutoLock({ now: NOW, lastActivityAt: badTimestamp, durationMinutes: 15 })).toBe(true);
    }
  );

  it('fails CLOSED (locks) when now itself is missing/corrupt', () => {
    expect(shouldAutoLock({ now: undefined, lastActivityAt: NOW - 1000, durationMinutes: 15 })).toBe(true);
    expect(shouldAutoLock({ now: NaN, lastActivityAt: NOW - 1000, durationMinutes: 15 })).toBe(true);
  });

  it.each([undefined, null, NaN, 'garbage', 12345, {}])(
    'fails CLOSED (locks) for an unrecognized/corrupt durationMinutes value (%s), even with a perfectly valid timestamp',
    (badDuration) => {
      expect(shouldAutoLock({ now: NOW, lastActivityAt: NOW - 1000, durationMinutes: badDuration })).toBe(true);
    }
  );

  it.each(AUTO_LOCK_OPTIONS_MINUTES.filter((v) => v !== AUTO_LOCK_NEVER))('works for every real numeric option (%s minutes)', (minutes) => {
    const justUnder = NOW - (minutes * 60_000 - 1);
    const justAtOrOver = NOW - minutes * 60_000;
    expect(shouldAutoLock({ now: NOW, lastActivityAt: justUnder, durationMinutes: minutes })).toBe(false);
    expect(shouldAutoLock({ now: NOW, lastActivityAt: justAtOrOver, durationMinutes: minutes })).toBe(true);
  });

  it('AUTO_LOCK_DEFAULT_MINUTES is one of the recognized options', () => {
    expect(AUTO_LOCK_OPTIONS_MINUTES).toContain(AUTO_LOCK_DEFAULT_MINUTES);
  });

  describe('1-minute duration — same as the alarm check interval (added in a later revision)', () => {
    it('does not lock one millisecond before the 1-minute boundary', () => {
      const lastActivityAt = NOW - 60_000 + 1;
      expect(shouldAutoLock({ now: NOW, lastActivityAt, durationMinutes: 1 })).toBe(false);
    });

    it('locks exactly at the 1-minute boundary — the same instant the alarm\'s own 1-minute check period could first observe it, not one check cycle later', () => {
      const lastActivityAt = NOW - 60_000; // exactly 60_000ms ago == exactly one AUTO_LOCK_CHECK_PERIOD_MINUTES
      expect(shouldAutoLock({ now: NOW, lastActivityAt, durationMinutes: 1 })).toBe(true);
    });

    it('locks well past the 1-minute boundary', () => {
      const lastActivityAt = NOW - 5 * 60_000;
      expect(shouldAutoLock({ now: NOW, lastActivityAt, durationMinutes: 1 })).toBe(true);
    });

    it('1 is included in AUTO_LOCK_OPTIONS_MINUTES, positioned first', () => {
      expect(AUTO_LOCK_OPTIONS_MINUTES[0]).toBe(1);
    });
  });
});
