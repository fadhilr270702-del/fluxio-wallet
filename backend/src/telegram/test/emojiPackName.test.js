import { describe, it, expect } from 'vitest';
import { parseEmojiPackName } from '../emojiPackName.js';

describe('parseEmojiPackName', () => {
  it('accepts a bare pack name', () => {
    expect(parseEmojiPackName('FinanceEmoji')).toBe('FinanceEmoji');
  });

  it('accepts a full https t.me/addemoji link', () => {
    expect(parseEmojiPackName('https://t.me/addemoji/FinanceEmoji')).toBe('FinanceEmoji');
  });

  it('accepts a scheme-less t.me link', () => {
    expect(parseEmojiPackName('t.me/addemoji/FinanceEmoji')).toBe('FinanceEmoji');
  });

  it('accepts an http (non-https) link', () => {
    expect(parseEmojiPackName('http://t.me/addemoji/FinanceEmoji')).toBe('FinanceEmoji');
  });

  it('accepts telegram.me as well as t.me', () => {
    expect(parseEmojiPackName('https://telegram.me/addemoji/FinanceEmoji')).toBe('FinanceEmoji');
  });

  it('accepts an addstickers link the same way (same t.me path shape)', () => {
    expect(parseEmojiPackName('https://t.me/addstickers/FinanceEmoji')).toBe('FinanceEmoji');
  });

  it('strips a trailing query string', () => {
    expect(parseEmojiPackName('https://t.me/addemoji/FinanceEmoji?utm=share')).toBe('FinanceEmoji');
  });

  it('strips a trailing slash', () => {
    expect(parseEmojiPackName('https://t.me/addemoji/FinanceEmoji/')).toBe('FinanceEmoji');
  });

  it('trims surrounding whitespace on a bare name', () => {
    expect(parseEmojiPackName('  FinanceEmoji  ')).toBe('FinanceEmoji');
  });

  it('accepts underscores (a real registered pack name from prompt 0151)', () => {
    expect(parseEmojiPackName('basedbot_chains_v3_by_FakePumPillBot')).toBe('basedbot_chains_v3_by_FakePumPillBot');
  });

  it('rejects a name containing a space', () => {
    expect(parseEmojiPackName('Finance Emoji')).toBeNull();
  });

  it('rejects a path-traversal attempt embedded in a link', () => {
    expect(parseEmojiPackName('https://t.me/addemoji/../../etc/passwd')).toBeNull();
  });

  it('rejects a bare path-traversal string with no link shape at all', () => {
    expect(parseEmojiPackName('../../etc/passwd')).toBeNull();
  });

  it('rejects a name with disallowed punctuation', () => {
    expect(parseEmojiPackName('Finance-Emoji')).toBeNull();
    expect(parseEmojiPackName('Finance.Emoji')).toBeNull();
    expect(parseEmojiPackName('Finance;Emoji')).toBeNull();
  });

  it('rejects a name longer than 64 characters', () => {
    expect(parseEmojiPackName('A'.repeat(65))).toBeNull();
  });

  it('accepts a name exactly 64 characters long', () => {
    expect(parseEmojiPackName('A'.repeat(64))).toBe('A'.repeat(64));
  });

  it('rejects an unrelated URL that only superficially resembles a Telegram link', () => {
    expect(parseEmojiPackName('https://evil.example.com/t.me/addemoji/FinanceEmoji')).toBeNull();
  });

  it('handles empty/whitespace-only/null/undefined input without throwing', () => {
    expect(parseEmojiPackName('')).toBeNull();
    expect(parseEmojiPackName('   ')).toBeNull();
    expect(parseEmojiPackName(null)).toBeNull();
    expect(parseEmojiPackName(undefined)).toBeNull();
  });
});
