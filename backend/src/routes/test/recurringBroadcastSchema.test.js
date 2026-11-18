import { describe, it, expect } from 'vitest';
// Prompt 0167 — imports the schema module directly, never the route file —
// see announcementSchemas.test.js's own updated comment for why.
import { createBroadcastSchema, updateContentSchema } from '../../schemas/telegramBroadcastSchemas.js';

const base = { title: 'Sale', body: 'Body text', targetType: 'subscribers' };
const inOneHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const inThePast = new Date(Date.now() - 60 * 60 * 1000).toISOString();

describe('createBroadcastSchema — recurringIntervalHours', () => {
  it('defaults to 1 when omitted', () => {
    const result = createBroadcastSchema.safeParse({ ...base, recurring: true });
    expect(result.success).toBe(true);
    expect(result.data.recurringIntervalHours).toBe(1);
  });

  // Prompt 0246 — the range was 1..24 until migration 0028 widened the
  // column's own CHECK to 1..168 (the old "rejects 25" case is now an
  // accepted value, a conscious revision).
  it('accepts values across the 1..168 range, including every Repeat every choice the composer offers', () => {
    for (const hours of [1, 2, 3, 6, 12, 23, 24, 25, 48, 72, 168]) {
      const result = createBroadcastSchema.safeParse({ ...base, recurring: true, recurringIntervalHours: hours });
      expect(result.success).toBe(true);
      expect(result.data.recurringIntervalHours).toBe(hours);
    }
  });

  it('rejects 0 (below the minimum)', () => {
    const result = createBroadcastSchema.safeParse({ ...base, recurring: true, recurringIntervalHours: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects 169 (above the maximum)', () => {
    const result = createBroadcastSchema.safeParse({ ...base, recurring: true, recurringIntervalHours: 169 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer value', () => {
    const result = createBroadcastSchema.safeParse({ ...base, recurring: true, recurringIntervalHours: 2.5 });
    expect(result.success).toBe(false);
  });

  it('rejects a negative value', () => {
    const result = createBroadcastSchema.safeParse({ ...base, recurring: true, recurringIntervalHours: -1 });
    expect(result.success).toBe(false);
  });
});

describe('createBroadcastSchema — recurringStartsAt', () => {
  it('is null/omitted for "Mulai sekarang" and passes through fine', () => {
    const result = createBroadcastSchema.safeParse({ ...base, recurring: true });
    expect(result.success).toBe(true);
    expect(result.data.recurringStartsAt).toBeUndefined();
  });

  it('accepts a future ISO timestamp', () => {
    const result = createBroadcastSchema.safeParse({ ...base, recurring: true, recurringStartsAt: inOneHour });
    expect(result.success).toBe(true);
    expect(result.data.recurringStartsAt).toBe(inOneHour);
  });

  it('rejects a past timestamp — same "must be in the future" rule as scheduledAt', () => {
    const result = createBroadcastSchema.safeParse({ ...base, recurring: true, recurringStartsAt: inThePast });
    expect(result.success).toBe(false);
  });

  it('rejects recurringStartsAt set while recurring is false (inconsistent combination)', () => {
    const result = createBroadcastSchema.safeParse({ ...base, recurring: false, recurringStartsAt: inOneHour });
    expect(result.success).toBe(false);
  });

  it('still rejects the pre-existing scheduledAt + recurring combination', () => {
    const result = createBroadcastSchema.safeParse({ ...base, recurring: true, scheduledAt: inOneHour });
    expect(result.success).toBe(false);
  });
});

// Prompt 0246 — the content edit can also carry a new recurring schedule:
// intervalHours + nextRunAt, optional but only ever as a PAIR.
describe('updateContentSchema — recurring schedule pair (prompt 0246)', () => {
  const content = { title: 'Edited', body: 'Edited body' };

  it('a content only edit carries no schedule fields at all', () => {
    const result = updateContentSchema.safeParse(content);
    expect(result.success).toBe(true);
    expect(result.data.intervalHours).toBeUndefined();
    expect(result.data.nextRunAt).toBeUndefined();
  });

  it('accepts the pair: an integer interval from 1 to 168 and a future nextRunAt', () => {
    for (const intervalHours of [1, 24, 72, 168]) {
      const result = updateContentSchema.safeParse({ ...content, intervalHours, nextRunAt: inOneHour });
      expect(result.success).toBe(true);
      expect(result.data.intervalHours).toBe(intervalHours);
      expect(result.data.nextRunAt).toBe(inOneHour);
    }
  });

  it('rejects one half of the pair without the other, naming the missing field', () => {
    const onlyInterval = updateContentSchema.safeParse({ ...content, intervalHours: 6 });
    expect(onlyInterval.success).toBe(false);
    expect(onlyInterval.error.issues[0].path).toEqual(['nextRunAt']);
    const onlyNextRun = updateContentSchema.safeParse({ ...content, nextRunAt: inOneHour });
    expect(onlyNextRun.success).toBe(false);
    expect(onlyNextRun.error.issues[0].path).toEqual(['intervalHours']);
  });

  it('rejects an interval of 0, 169, or a non integer', () => {
    for (const intervalHours of [0, 169, 1.5, -2]) {
      const result = updateContentSchema.safeParse({ ...content, intervalHours, nextRunAt: inOneHour });
      expect(result.success).toBe(false);
      expect(result.error.issues[0].path).toEqual(['intervalHours']);
    }
  });

  it('rejects a nextRunAt in the past with a clear message, and one that is not a date', () => {
    const past = updateContentSchema.safeParse({ ...content, intervalHours: 6, nextRunAt: inThePast });
    expect(past.success).toBe(false);
    expect(past.error.issues[0].path).toEqual(['nextRunAt']);
    expect(past.error.issues[0].message).toBe('The next round must be in the future.');
    const garbage = updateContentSchema.safeParse({ ...content, intervalHours: 6, nextRunAt: 'not a date' });
    expect(garbage.success).toBe(false);
    expect(garbage.error.issues[0].path).toEqual(['nextRunAt']);
  });
});
