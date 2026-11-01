import { describe, it, expect } from 'vitest';
import { formatScheduleSummary } from '../scheduleSummary.js';

describe('formatScheduleSummary — four combinations', () => {
  it('is null when neither startsAt nor endsAt is set', () => {
    expect(formatScheduleSummary({ startsAt: '', endsAt: '' })).toBeNull();
    expect(formatScheduleSummary({ startsAt: null, endsAt: null })).toBeNull();
    expect(formatScheduleSummary({})).toBeNull();
  });

  it('reads "Visible from <date>" when only startsAt is set', () => {
    const result = formatScheduleSummary({ startsAt: '2026-01-15T14:30', endsAt: '' });
    expect(result).toMatch(/^Visible from /);
    expect(result).not.toMatch(/ to /);
  });

  it('reads "Visible until <date>" when only endsAt is set', () => {
    const result = formatScheduleSummary({ startsAt: '', endsAt: '2026-02-20T09:00' });
    expect(result).toMatch(/^Visible until /);
    expect(result).not.toMatch(/ from /);
  });

  it('reads "Visible <date> to <date>" when both are set', () => {
    const result = formatScheduleSummary({ startsAt: '2026-01-15T14:30', endsAt: '2026-02-20T09:00' });
    expect(result).toMatch(/^Visible /);
    expect(result).toMatch(/ to /);
    expect(result).not.toMatch(/^Visible from /);
    expect(result).not.toMatch(/^Visible until /);
  });
});

describe('formatScheduleSummary — accepts real ISO strings too, not just datetime-local values', () => {
  it('formats an ISO-8601 startsAt the same way as a datetime-local value', () => {
    const result = formatScheduleSummary({ startsAt: '2026-01-15T14:30:00.000Z', endsAt: null });
    expect(result).toMatch(/^Visible from /);
  });
});
