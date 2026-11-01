import { describe, it, expect } from 'vitest';
import {
  IMPORT_WORD_COUNTS,
  splitPastedWords,
  distributeWordsToBoxes,
  suggestWordCountForPaste,
  remapWordsForBoxCountChange,
  wordsWouldBeDiscarded,
  isGridComplete
} from '../shared/importSeedGrid.js';

const WORDS_12 = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const WORDS_24 = [
  ...WORDS_12,
  'account', 'accuse', 'achieve', 'acid', 'acoustic', 'acquire', 'across', 'act', 'action', 'actor', 'actress', 'actual'
];

describe('IMPORT_WORD_COUNTS', () => {
  it('is exactly [12, 24]', () => {
    expect(IMPORT_WORD_COUNTS).toEqual([12, 24]);
  });
});

describe('splitPastedWords', () => {
  it('splits on single spaces', () => {
    expect(splitPastedWords('abandon ability able')).toEqual(['abandon', 'ability', 'able']);
  });

  it('splits on mixed whitespace — tabs, newlines, multiple spaces of varying run length', () => {
    expect(splitPastedWords('abandon\tability\n\nable   about')).toEqual(['abandon', 'ability', 'able', 'about']);
  });

  it('trims leading/trailing whitespace without producing empty entries', () => {
    expect(splitPastedWords('  abandon ability  ')).toEqual(['abandon', 'ability']);
  });

  it('lowercases uppercase/mixed-case input', () => {
    expect(splitPastedWords('ABANDON Ability ABLE')).toEqual(['abandon', 'ability', 'able']);
  });

  it('returns an empty array for empty or whitespace-only input', () => {
    expect(splitPastedWords('')).toEqual([]);
    expect(splitPastedWords('   \n\t  ')).toEqual([]);
  });

  it('returns an empty array for non-string input, never throwing', () => {
    expect(splitPastedWords(undefined)).toEqual([]);
    expect(splitPastedWords(null)).toEqual([]);
    expect(splitPastedWords(123)).toEqual([]);
  });

  it('handles a full real 24-word phrase', () => {
    expect(splitPastedWords(WORDS_24.join(' '))).toEqual(WORDS_24);
  });
});

describe('distributeWordsToBoxes', () => {
  it('fills exactly 12 boxes from a 12-word list, matching exactly', () => {
    expect(distributeWordsToBoxes(WORDS_12, 12)).toEqual(WORDS_12);
  });

  it('fills exactly 24 boxes from a 24-word list, matching exactly', () => {
    expect(distributeWordsToBoxes(WORDS_24, 24)).toEqual(WORDS_24);
  });

  it('pads remaining boxes with empty strings when there are fewer words than boxes', () => {
    const result = distributeWordsToBoxes(['abandon', 'ability'], 12);
    expect(result).toHaveLength(12);
    expect(result.slice(0, 2)).toEqual(['abandon', 'ability']);
    expect(result.slice(2)).toEqual(new Array(10).fill(''));
  });

  it('drops extra words beyond the box count when there are more words than boxes', () => {
    const result = distributeWordsToBoxes(WORDS_24, 12);
    expect(result).toEqual(WORDS_12);
  });

  it('always starts from box 1 regardless of any notion of "where the paste happened" — this function takes no such parameter at all, by construction', () => {
    // The function signature itself proves this (words, boxCount) — there
    // is no third "start index" argument to even pass a mid-grid position
    // to. Asserting the behavior directly: the FIRST word always lands in
    // the FIRST box.
    const result = distributeWordsToBoxes(['zebra', 'yellow', 'xray'], 5);
    expect(result[0]).toBe('zebra');
    expect(result[1]).toBe('yellow');
    expect(result[2]).toBe('xray');
    expect(result[3]).toBe('');
    expect(result[4]).toBe('');
  });

  it('returns an all-empty array of the right length for zero pasted words', () => {
    expect(distributeWordsToBoxes([], 12)).toEqual(new Array(12).fill(''));
  });
});

describe('suggestWordCountForPaste', () => {
  it('suggests 24 when 24 words are pasted into a 12-word grid', () => {
    expect(suggestWordCountForPaste(24, 12)).toBe(24);
  });

  it('suggests 12 when 12 words are pasted into a 24-word grid', () => {
    expect(suggestWordCountForPaste(12, 24)).toBe(12);
  });

  it('suggests nothing when the pasted count already matches the current grid', () => {
    expect(suggestWordCountForPaste(12, 12)).toBeNull();
    expect(suggestWordCountForPaste(24, 24)).toBeNull();
  });

  it('suggests nothing for a non-12/24 count, however close', () => {
    expect(suggestWordCountForPaste(15, 12)).toBeNull();
    expect(suggestWordCountForPaste(11, 12)).toBeNull();
    expect(suggestWordCountForPaste(13, 24)).toBeNull();
    expect(suggestWordCountForPaste(0, 12)).toBeNull();
  });
});

describe('remapWordsForBoxCountChange', () => {
  it('12 -> 24 keeps all 12 words and pads 12 more empty boxes', () => {
    const result = remapWordsForBoxCountChange(WORDS_12, 24);
    expect(result).toHaveLength(24);
    expect(result.slice(0, 12)).toEqual(WORDS_12);
    expect(result.slice(12)).toEqual(new Array(12).fill(''));
  });

  it('24 -> 12 keeps the first 12 words and drops words 13-24', () => {
    const result = remapWordsForBoxCountChange(WORDS_24, 12);
    expect(result).toEqual(WORDS_12);
  });

  it('is idempotent when the box count does not change', () => {
    expect(remapWordsForBoxCountChange(WORDS_12, 12)).toEqual(WORDS_12);
  });

  it('pads a partially-filled 12-box grid up to 24 correctly', () => {
    const partial = ['abandon', 'ability', '', '', '', '', '', '', '', '', '', ''];
    const result = remapWordsForBoxCountChange(partial, 24);
    expect(result).toHaveLength(24);
    expect(result[0]).toBe('abandon');
    expect(result[1]).toBe('ability');
    expect(result.slice(2)).toEqual(new Array(22).fill(''));
  });
});

describe('wordsWouldBeDiscarded', () => {
  it('is false going 12 -> 24 (padding only, nothing is ever dropped in that direction)', () => {
    expect(wordsWouldBeDiscarded(WORDS_12, 24)).toBe(false);
  });

  it('is true going 24 -> 12 when words 13-24 are all filled in', () => {
    expect(wordsWouldBeDiscarded(WORDS_24, 12)).toBe(true);
  });

  it('is false going 24 -> 12 when words 13-24 are still empty (nothing real to lose)', () => {
    const words = [...WORDS_12, ...new Array(12).fill('')];
    expect(wordsWouldBeDiscarded(words, 12)).toBe(false);
  });

  it('is true if even ONE of the words beyond the new box count is non-empty', () => {
    const words = [...WORDS_12, 'account', ...new Array(11).fill('')];
    expect(wordsWouldBeDiscarded(words, 12)).toBe(true);
  });

  it('treats a whitespace-only leftover word as empty, not as real content to protect', () => {
    const words = [...WORDS_12, '   ', ...new Array(11).fill('')];
    expect(wordsWouldBeDiscarded(words, 12)).toBe(false);
  });
});

describe('isGridComplete', () => {
  it('is true when every box has a non-empty word', () => {
    expect(isGridComplete(WORDS_12)).toBe(true);
    expect(isGridComplete(WORDS_24)).toBe(true);
  });

  it('is false when any box is empty', () => {
    expect(isGridComplete(['abandon', '', 'able'])).toBe(false);
  });

  it('is false when any box is whitespace-only', () => {
    expect(isGridComplete(['abandon', '   ', 'able'])).toBe(false);
  });

  it('is false for an empty array (no boxes at all)', () => {
    expect(isGridComplete([])).toBe(false);
  });
});
