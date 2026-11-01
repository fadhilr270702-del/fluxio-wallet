import { describe, it, expect } from 'vitest';
import { parseRootMargin, isRectNearViewport } from '../isRectNearViewport.js';

function rect({ top, right, bottom, left }) {
  return { top, right, bottom, left };
}

describe('parseRootMargin', () => {
  it('applies one value to all four sides', () => {
    expect(parseRootMargin('200px')).toEqual({ top: 200, right: 200, bottom: 200, left: 200 });
  });

  it('applies two values as top/bottom then left/right', () => {
    expect(parseRootMargin('10px 20px')).toEqual({ top: 10, right: 20, bottom: 10, left: 20 });
  });

  it('applies three values as top, left/right, bottom', () => {
    expect(parseRootMargin('10px 20px 30px')).toEqual({ top: 10, right: 20, bottom: 30, left: 20 });
  });

  it('applies four values in top/right/bottom/left order', () => {
    expect(parseRootMargin('10px 20px 30px 40px')).toEqual({ top: 10, right: 20, bottom: 30, left: 40 });
  });

  it('defaults to zero margin for null/undefined', () => {
    expect(parseRootMargin(undefined)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(parseRootMargin(null)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('falls back to zero for an unparsable token rather than throwing', () => {
    expect(parseRootMargin('not-a-number')).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});

describe('isRectNearViewport', () => {
  const VIEWPORT_W = 1400;
  const VIEWPORT_H = 900;

  it('is true for a rect fully inside the viewport with no margin', () => {
    expect(isRectNearViewport(rect({ top: 100, right: 200, bottom: 150, left: 100 }), VIEWPORT_W, VIEWPORT_H, '0px')).toBe(true);
  });

  it('is false for a rect entirely below the viewport with no margin', () => {
    expect(isRectNearViewport(rect({ top: 1231, right: 841, bottom: 1251, left: 821 }), VIEWPORT_W, VIEWPORT_H, '0px')).toBe(false);
  });

  it('is false for a rect entirely above/left of the viewport with no margin', () => {
    expect(isRectNearViewport(rect({ top: -300, right: -100, bottom: -250, left: -200 }), VIEWPORT_W, VIEWPORT_H, '0px')).toBe(false);
  });

  it('a rootMargin can pull an otherwise-below-viewport rect into range', () => {
    const belowByOneHundred = rect({ top: 950, right: 300, bottom: 1000, left: 200 });
    expect(isRectNearViewport(belowByOneHundred, VIEWPORT_W, VIEWPORT_H, '0px')).toBe(false);
    expect(isRectNearViewport(belowByOneHundred, VIEWPORT_W, VIEWPORT_H, '200px')).toBe(true);
  });

  it('a rect straddling the viewport edge is true even with zero margin', () => {
    expect(isRectNearViewport(rect({ top: 880, right: 300, bottom: 920, left: 200 }), VIEWPORT_W, VIEWPORT_H, '0px')).toBe(true);
  });

  it('undefined rootMargin behaves like zero margin', () => {
    expect(isRectNearViewport(rect({ top: 100, right: 200, bottom: 150, left: 100 }), VIEWPORT_W, VIEWPORT_H, undefined)).toBe(true);
    expect(isRectNearViewport(rect({ top: 1231, right: 841, bottom: 1251, left: 821 }), VIEWPORT_W, VIEWPORT_H, undefined)).toBe(false);
  });
});
