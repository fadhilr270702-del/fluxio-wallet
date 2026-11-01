import { describe, it, expect } from 'vitest';
// Prompt 0167 — imports the schema module directly, never the route file —
// see announcementSchemas.test.js's own updated comment for why.
import { createBroadcastSchema } from '../../schemas/telegramBroadcastSchemas.js';

const base = { title: 'Sale', body: 'Body text', targetType: 'subscribers' };
const inOneHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const inThePast = new Date(Date.now() - 60 * 60 * 1000).toISOString();

describe('createBroadcastSchema — recurringIntervalHours', () => {
  it('defaults to 1 when omitted', () => {
    const result = createBroadcastSchema.safeParse({ ...base, recurring: true });
    expect(result.success).toBe(true);
    expect(result.data.recurringIntervalHours).toBe(1);
  });

  it('accepts every value in the 1..24 range', () => {
    for (const hours of [1, 2, 12, 23, 24]) {
      const result = createBroadcastSchema.safeParse({ ...base, recurring: true, recurringIntervalHours: hours });
      expect(result.success).toBe(true);
      expect(result.data.recurringIntervalHours).toBe(hours);
    }
  });

  it('rejects 0 (below the minimum)', () => {
    const result = createBroadcastSchema.safeParse({ ...base, recurring: true, recurringIntervalHours: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects 25 (above the maximum)', () => {
    const result = createBroadcastSchema.safeParse({ ...base, recurring: true, recurringIntervalHours: 25 });
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
