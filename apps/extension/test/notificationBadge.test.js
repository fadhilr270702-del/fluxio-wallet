import { describe, it, expect } from 'vitest';
import { countUnread, formatBadgeText } from '../shared/notificationBadge.js';

describe('countUnread', () => {
  it('counts announcements whose id is not in readIds', () => {
    const announcements = [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }];
    expect(countUnread(announcements, ['a1'])).toBe(2);
  });

  it('is 0 when every id is already read', () => {
    const announcements = [{ id: 'a1' }, { id: 'a2' }];
    expect(countUnread(announcements, ['a1', 'a2'])).toBe(0);
  });

  it('is 0 for an empty announcements list', () => {
    expect(countUnread([], [])).toBe(0);
  });

  it('treats a non-array announcements input as 0 rather than throwing', () => {
    expect(countUnread(null, [])).toBe(0);
  });

  it('treats a non-array readIds input as "nothing read yet" rather than throwing', () => {
    expect(countUnread([{ id: 'a1' }], null)).toBe(1);
  });
});

describe('formatBadgeText', () => {
  it('is an empty string for 0 (hides the badge)', () => {
    expect(formatBadgeText(0)).toBe('');
  });

  it('is the plain count for a small number', () => {
    expect(formatBadgeText(5)).toBe('5');
  });

  it('caps at "99+" for anything over 99', () => {
    expect(formatBadgeText(120)).toBe('99+');
  });

  it('is exactly "99" at the boundary, not "99+"', () => {
    expect(formatBadgeText(99)).toBe('99');
  });

  it('is "99+" at exactly 100', () => {
    expect(formatBadgeText(100)).toBe('99+');
  });

  it('treats a negative count the same as 0 rather than throwing', () => {
    expect(formatBadgeText(-1)).toBe('');
  });
});
