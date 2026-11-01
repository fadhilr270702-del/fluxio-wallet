import { describe, it, expect } from 'vitest';
import { docContainsPremiumEmoji, buttonsContainPremiumIcon, hasPremiumEmojiContent, shouldShowPremiumEmojiWarning } from '../premiumEmojiWarning.js';

function textPara(text) {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function premiumEmojiPara(id = '1', fallback = '⭐') {
  return { type: 'paragraph', content: [{ type: 'premiumEmoji', attrs: { id, fallback } }] };
}

describe('docContainsPremiumEmoji', () => {
  it('is false for a plain-text-only doc', () => {
    expect(docContainsPremiumEmoji({ type: 'doc', content: [textPara('Hello')] })).toBe(false);
  });

  it('is true when a premiumEmoji node exists anywhere in the doc', () => {
    expect(docContainsPremiumEmoji({ type: 'doc', content: [textPara('Hello'), premiumEmojiPara()] })).toBe(true);
  });

  it('finds a premiumEmoji node nested inside other content', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'before ' }, { type: 'premiumEmoji', attrs: { id: '1', fallback: '⭐' } }] }] };
    expect(docContainsPremiumEmoji(doc)).toBe(true);
  });

  it('handles a null/undefined doc without throwing', () => {
    expect(docContainsPremiumEmoji(null)).toBe(false);
    expect(docContainsPremiumEmoji(undefined)).toBe(false);
  });
});

describe('buttonsContainPremiumIcon', () => {
  it('is false for an empty/undefined button list', () => {
    expect(buttonsContainPremiumIcon([])).toBe(false);
    expect(buttonsContainPremiumIcon(undefined)).toBe(false);
  });

  it('is false when no button has an icon', () => {
    expect(buttonsContainPremiumIcon([{ text: 'a', url: 'https://x.com' }])).toBe(false);
  });

  it('is true when any button has iconCustomEmojiId set', () => {
    expect(buttonsContainPremiumIcon([{ text: 'a', url: 'https://x.com' }, { text: 'b', url: 'https://y.com', iconCustomEmojiId: '123' }])).toBe(true);
  });

  it('treats a null iconCustomEmojiId the same as absent', () => {
    expect(buttonsContainPremiumIcon([{ text: 'a', url: 'https://x.com', iconCustomEmojiId: null }])).toBe(false);
  });
});

describe('hasPremiumEmojiContent', () => {
  it('is false when title, body, and buttons are all plain', () => {
    expect(hasPremiumEmojiContent({
      titleDoc: { type: 'doc', content: [textPara('Title')] },
      bodyDoc: { type: 'doc', content: [textPara('Body')] },
      buttons: [{ text: 'a', url: 'https://x.com' }]
    })).toBe(false);
  });

  it('is true when only the title has a premium emoji', () => {
    expect(hasPremiumEmojiContent({ titleDoc: { type: 'doc', content: [premiumEmojiPara()] }, bodyDoc: null, buttons: [] })).toBe(true);
  });

  it('is true when only the body has a premium emoji', () => {
    expect(hasPremiumEmojiContent({ titleDoc: null, bodyDoc: { type: 'doc', content: [premiumEmojiPara()] }, buttons: [] })).toBe(true);
  });

  it('is true when only a button has a premium icon', () => {
    expect(hasPremiumEmojiContent({ titleDoc: null, bodyDoc: null, buttons: [{ text: 'a', url: 'https://x.com', iconCustomEmojiId: '1' }] })).toBe(true);
  });

  // Prompt 0156 — the "both" case: a text-level premium emoji AND a
  // button icon present at once. The union (`||`) in hasPremiumEmojiContent
  // already made this true from the day it was written in 0153 (confirmed
  // by reading its own body before assuming a fix was needed) — this test
  // makes that explicit rather than leaving it implied by the two
  // individual-source tests above.
  it('is true when BOTH a text-level premium emoji and a button icon are present', () => {
    expect(hasPremiumEmojiContent({
      titleDoc: { type: 'doc', content: [premiumEmojiPara()] },
      bodyDoc: { type: 'doc', content: [textPara('Body')] },
      buttons: [{ text: 'a', url: 'https://x.com', iconCustomEmojiId: '1' }]
    })).toBe(true);
  });

  it('handles a completely empty call without throwing', () => {
    expect(hasPremiumEmojiContent()).toBe(false);
  });
});

describe('shouldShowPremiumEmojiWarning', () => {
  it('never shows when there is no premium content, regardless of bot/target', () => {
    expect(shouldShowPremiumEmojiWarning({ hasPremiumContent: false, botId: 'test', targetType: 'channel' })).toBe(false);
  });

  it('shows on the trial bot when premium content exists, regardless of target', () => {
    expect(shouldShowPremiumEmojiWarning({ hasPremiumContent: true, botId: 'test', targetType: 'subscribers' })).toBe(true);
    expect(shouldShowPremiumEmojiWarning({ hasPremiumContent: true, botId: 'test', targetType: 'channel' })).toBe(true);
  });

  it('shows on the official bot when the target is a channel', () => {
    expect(shouldShowPremiumEmojiWarning({ hasPremiumContent: true, botId: 'official', targetType: 'channel' })).toBe(true);
  });

  it('does NOT show on the official bot sending to subscribers — the one case that genuinely renders', () => {
    expect(shouldShowPremiumEmojiWarning({ hasPremiumContent: true, botId: 'official', targetType: 'subscribers' })).toBe(false);
  });

  it('Welcome has no targetType at all — degrades to just the trial-bot check', () => {
    expect(shouldShowPremiumEmojiWarning({ hasPremiumContent: true, botId: 'test' })).toBe(true);
    expect(shouldShowPremiumEmojiWarning({ hasPremiumContent: true, botId: 'official' })).toBe(false);
  });
});
