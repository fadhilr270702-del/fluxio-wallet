import { describe, it, expect } from 'vitest';
import { resolveDataBotId } from '../resolveDataBotId.js';

describe('resolveDataBotId', () => {
  it('an explicit prop wins over context when both are given', () => {
    expect(resolveDataBotId('official', 'test')).toEqual({ botId: 'official', source: 'prop' });
  });

  it('falls back to context when no prop is given', () => {
    expect(resolveDataBotId(undefined, 'official')).toEqual({ botId: 'official', source: 'context' });
    expect(resolveDataBotId(null, 'official')).toEqual({ botId: 'official', source: 'context' });
    expect(resolveDataBotId('', 'official')).toEqual({ botId: 'official', source: 'context' });
  });

  it('both missing resolves to null with an explicit "missing" reason — never a silent fallback', () => {
    expect(resolveDataBotId(undefined, undefined)).toEqual({ botId: null, source: 'missing' });
    expect(resolveDataBotId(null, null)).toEqual({ botId: null, source: 'missing' });
    expect(resolveDataBotId('', '')).toEqual({ botId: null, source: 'missing' });
  });

  it('the prop wins even when the context value differs, for every non-empty prop value', () => {
    expect(resolveDataBotId('test', 'official')).toEqual({ botId: 'test', source: 'prop' });
  });

  it('never fabricates a value that was not actually given by either source', () => {
    const result = resolveDataBotId(undefined, undefined);
    expect(result.botId).toBeNull();
    expect(result.source).toBe('missing');
  });
});
