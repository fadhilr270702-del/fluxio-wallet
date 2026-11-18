import { describe, it, expect } from 'vitest';
import {
  RECURRING_INTERVAL_CHOICES,
  MAX_RECURRING_INTERVAL_HOURS,
  recurringIntervalOptions,
  initialScheduleEditState,
  resolveRecurringScheduleEdit
} from '../recurringScheduleEdit.js';
import { toDatetimeLocalValue } from '../../../../utils/formatDate.js';

// Prompt 0246 — the Edit page's schedule section for a recurring
// broadcast: what the two inputs start as, and what (if anything) the
// Save request carries for them. Broadcast fixtures use the API's real
// field names (recurringIntervalHours / recurringNextRoundAt).
const NOW = new Date(2026, 10, 16, 12, 0, 0).getTime();
const localInput = (y, m, d, h, min) => toDatetimeLocalValue(new Date(y, m, d, h, min).toISOString());

// Prompt 0246 Revisi 1 (owner decision, 17 November 2026): every hour from
// 1 to 24 with no gaps, then 48, 72, 168. Written out in full on purpose,
// so this test does not share the constant's own construction.
const OWNER_LIST = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 48, 72, 168];

describe('recurringIntervalOptions', () => {
  it('offers exactly the owner list: 27 choices, 1 to 24 hours with no gaps, then 48, 72, 168', () => {
    expect(OWNER_LIST).toHaveLength(27);
    expect(RECURRING_INTERVAL_CHOICES).toEqual(OWNER_LIST);
    expect(MAX_RECURRING_INTERVAL_HOURS).toBe(168);
    expect(recurringIntervalOptions(24)).toEqual(OWNER_LIST);
    expect(recurringIntervalOptions(1)).toEqual(OWNER_LIST);
    // 4 hours used to be an off-list value; it is a plain choice now, never duplicated.
    expect(recurringIntervalOptions(4)).toEqual(OWNER_LIST);
  });

  it('the list is strictly increasing with no duplicates', () => {
    for (let i = 1; i < RECURRING_INTERVAL_CHOICES.length; i += 1) {
      expect(RECURRING_INTERVAL_CHOICES[i]).toBeGreaterThan(RECURRING_INTERVAL_CHOICES[i - 1]);
    }
  });

  it('keeps a current value that is not on the list (a broadcast copied to the form with 36 or 100 hours), in order', () => {
    expect(recurringIntervalOptions(36)).toEqual([...OWNER_LIST.slice(0, 24), 36, 48, 72, 168]);
    expect(recurringIntervalOptions(100)).toEqual([...OWNER_LIST.slice(0, 26), 100, 168]);
    expect(recurringIntervalOptions(36)).toHaveLength(28);
  });

  it('ignores a value that could never be saved', () => {
    for (const bad of [0, 169, 2.5, NaN, undefined, null]) {
      expect(recurringIntervalOptions(bad)).toEqual(OWNER_LIST);
    }
  });
});

describe('initialScheduleEditState', () => {
  it('prefills the interval and the next round (browser local time) when that round is still ahead', () => {
    const next = new Date(2026, 10, 16, 18, 0, 0).toISOString();
    expect(initialScheduleEditState({ recurringIntervalHours: 6, recurringNextRoundAt: next }, NOW)).toEqual({
      intervalHours: '6',
      nextRoundLocal: localInput(2026, 10, 16, 18, 0)
    });
  });

  it('leaves the next round empty when it is due now or a round is in progress (nothing in the future to show)', () => {
    const past = new Date(2026, 10, 16, 11, 59, 0).toISOString();
    expect(initialScheduleEditState({ recurringIntervalHours: 24, recurringNextRoundAt: past }, NOW)).toEqual({
      intervalHours: '24',
      nextRoundLocal: ''
    });
    expect(initialScheduleEditState({ recurringIntervalHours: 24, recurringNextRoundAt: null }, NOW).nextRoundLocal).toBe('');
  });
});

describe('resolveRecurringScheduleEdit', () => {
  const original = { intervalHours: '6', nextRoundLocal: localInput(2026, 10, 16, 18, 0) };

  it('nothing touched: no schedule change, so the Save request stays content only', () => {
    expect(resolveRecurringScheduleEdit({ original, current: { ...original }, now: NOW })).toEqual({ changed: false });
  });

  it('nothing touched stays "no change" even when the prefilled time has passed while the page sat open', () => {
    const stale = { intervalHours: '6', nextRoundLocal: localInput(2026, 10, 16, 11, 0) }; // an hour before NOW
    expect(resolveRecurringScheduleEdit({ original: stale, current: { ...stale }, now: NOW })).toEqual({ changed: false });
  });

  it('interval changed: sends the pair, next round as a UTC ISO string of the local input', () => {
    const result = resolveRecurringScheduleEdit({ original, current: { ...original, intervalHours: '48' }, now: NOW });
    expect(result).toEqual({ changed: true, intervalHours: 48, nextRunAt: new Date(2026, 10, 16, 18, 0).toISOString() });
  });

  it('next round changed: sends the pair with the unchanged interval', () => {
    const current = { intervalHours: '6', nextRoundLocal: localInput(2026, 10, 19, 9, 30) };
    expect(resolveRecurringScheduleEdit({ original, current, now: NOW })).toEqual({
      changed: true,
      intervalHours: 6,
      nextRunAt: new Date(2026, 10, 19, 9, 30).toISOString()
    });
  });

  it('rejects an interval that is empty, not whole, or outside 1 to 168', () => {
    for (const intervalHours of ['', '0', '169', '2.5', 'abc', '-3']) {
      const result = resolveRecurringScheduleEdit({ original, current: { ...original, intervalHours }, now: NOW });
      expect(result).toEqual({ error: 'Interval must be a whole number of hours from 1 to 168.' });
    }
  });

  it('a changed schedule needs a next round: empty asks for one, a past one is refused', () => {
    expect(resolveRecurringScheduleEdit({ original, current: { intervalHours: '12', nextRoundLocal: '' }, now: NOW })).toEqual({
      error: 'Pick the date and time of the next round.'
    });
    const past = { intervalHours: '12', nextRoundLocal: localInput(2026, 10, 16, 11, 0) };
    expect(resolveRecurringScheduleEdit({ original, current: past, now: NOW })).toEqual({
      error: 'The next round must be in the future.'
    });
  });

  it('when the page opened with no future next round, changing only the interval still asks for the next round', () => {
    const opened = { intervalHours: '6', nextRoundLocal: '' };
    expect(resolveRecurringScheduleEdit({ original: opened, current: { ...opened }, now: NOW })).toEqual({ changed: false });
    expect(resolveRecurringScheduleEdit({ original: opened, current: { intervalHours: '24', nextRoundLocal: '' }, now: NOW })).toEqual({
      error: 'Pick the date and time of the next round.'
    });
  });

  it('every message is free of dashes', () => {
    const messages = [
      resolveRecurringScheduleEdit({ original, current: { ...original, intervalHours: '0' }, now: NOW }).error,
      resolveRecurringScheduleEdit({ original, current: { intervalHours: '12', nextRoundLocal: '' }, now: NOW }).error,
      resolveRecurringScheduleEdit({ original, current: { intervalHours: '12', nextRoundLocal: localInput(2026, 10, 16, 11, 0) }, now: NOW }).error
    ];
    for (const message of messages) {
      expect(/[-–—]/.test(message)).toBe(false);
    }
  });
});
