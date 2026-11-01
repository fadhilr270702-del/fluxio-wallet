import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from '../relativeTime.js';

const NOW = 1_700_000_000_000; // an arbitrary fixed instant, always passed explicitly

describe('formatRelativeTime', () => {
  it('shows "just now" for anything under 60 seconds', () => {
    expect(formatRelativeTime(NOW, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 1000, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 59_000, NOW)).toBe('just now');
  });

  it('switches to minutes at the 60-second boundary', () => {
    expect(formatRelativeTime(NOW - 60_000, NOW)).toBe('1m ago');
    expect(formatRelativeTime(NOW - 119_000, NOW)).toBe('1m ago');
    expect(formatRelativeTime(NOW - 120_000, NOW)).toBe('2m ago');
  });

  it('switches to hours at the 60-minute boundary', () => {
    expect(formatRelativeTime(NOW - 59 * 60_000, NOW)).toBe('59m ago');
    expect(formatRelativeTime(NOW - 60 * 60_000, NOW)).toBe('1h ago');
    expect(formatRelativeTime(NOW - 90 * 60_000, NOW)).toBe('1h ago');
  });

  it('switches to days at the 24-hour boundary', () => {
    expect(formatRelativeTime(NOW - 23 * 3_600_000, NOW)).toBe('23h ago');
    expect(formatRelativeTime(NOW - 24 * 3_600_000, NOW)).toBe('1d ago');
    expect(formatRelativeTime(NOW - 3 * 24 * 3_600_000, NOW)).toBe('3d ago');
  });

  it('switches to months at the 30-day boundary', () => {
    expect(formatRelativeTime(NOW - 29 * 86_400_000, NOW)).toBe('29d ago');
    expect(formatRelativeTime(NOW - 30 * 86_400_000, NOW)).toBe('1mo ago');
  });

  it('switches to years at the 12-month boundary', () => {
    expect(formatRelativeTime(NOW - 364 * 86_400_000, NOW)).toBe('12mo ago');
    expect(formatRelativeTime(NOW - 365 * 86_400_000, NOW)).toBe('1y ago');
    expect(formatRelativeTime(NOW - 800 * 86_400_000, NOW)).toBe('2y ago');
  });

  it('treats a future timestamp (clock skew) as "just now" rather than a negative duration', () => {
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe('just now');
  });

  it('defaults `now` to the real current time when not given (smoke check only, not asserting an exact string)', () => {
    const result = formatRelativeTime(Date.now() - 5000);
    expect(result).toBe('just now');
  });
});
