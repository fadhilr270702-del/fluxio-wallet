import { describe, it, expect } from 'vitest';
import { classifySendError, computeRoundOutcome } from '../recurringRoundOutcome.js';
import { TelegramApiError } from '../client.js';

describe('classifySendError', () => {
  it('classifies a 429 TelegramApiError as rate_limited', () => {
    expect(classifySendError(new TelegramApiError(429, 'Too Many Requests', 5))).toBe('rate_limited');
  });

  it('classifies a 403 TelegramApiError (blocked) as recipient', () => {
    expect(classifySendError(new TelegramApiError(403, 'Forbidden: bot was blocked by the user'))).toBe('recipient');
  });

  it('classifies a 400 TelegramApiError (chat not found) as recipient', () => {
    expect(classifySendError(new TelegramApiError(400, 'Bad Request: chat not found'))).toBe('recipient');
  });

  it('classifies any other TelegramApiError code as recipient too', () => {
    expect(classifySendError(new TelegramApiError(404, 'Not Found'))).toBe('recipient');
  });

  // Real Node/undici network error shapes — not TelegramApiError, so a
  // valid API response was never received at all.
  it('classifies a real ECONNRESET error as transport', () => {
    const err = new Error('socket hang up');
    err.code = 'ECONNRESET';
    expect(classifySendError(err)).toBe('transport');
  });

  it('classifies a real ENOTFOUND (DNS failure) error as transport', () => {
    const err = new Error('getaddrinfo ENOTFOUND api.telegram.org');
    err.code = 'ENOTFOUND';
    expect(classifySendError(err)).toBe('transport');
  });

  it('classifies a real AbortSignal.timeout() rejection (name: TimeoutError) as transport', () => {
    // What AbortSignal.timeout()'s own abort reason actually looks like in
    // Node — a DOMException, not a plain Error.
    const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(classifySendError(err)).toBe('transport');
  });

  it('classifies a real AbortError (name: AbortError) as transport', () => {
    const err = new DOMException('The operation was aborted', 'AbortError');
    expect(classifySendError(err)).toBe('transport');
  });

  it('classifies undici\'s real TypeError("fetch failed") wrapper as transport', () => {
    // This is genuinely what a failed fetch() connection attempt throws in
    // Node — a plain TypeError with this exact message, wrapping the real
    // cause (e.g. ECONNREFUSED) in .cause.
    const err = new TypeError('fetch failed');
    err.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
    expect(classifySendError(err)).toBe('transport');
  });

  it('classifies a plain Error with no TelegramApiError shape as transport (the safe default)', () => {
    expect(classifySendError(new Error('something unexpected'))).toBe('transport');
  });
});

describe('computeRoundOutcome', () => {
  it('all recipients succeed', () => {
    const outcome = computeRoundOutcome(['success', 'success', 'success'], { hadSubscribers: true });
    expect(outcome).toEqual({ success: true, sentCount: 3, failedCount: 0, failureReason: null });
  });

  it('partial success — some recipient errors, loop still completes, round still counts as sent', () => {
    const outcome = computeRoundOutcome(['success', 'recipient_error', 'success'], { hadSubscribers: true });
    expect(outcome).toEqual({ success: true, sentCount: 2, failedCount: 1, failureReason: null });
  });

  it('all recipient errors — zero delivered despite having subscribers — round fails, no DB advance', () => {
    const outcome = computeRoundOutcome(['recipient_error', 'recipient_error'], { hadSubscribers: true });
    expect(outcome).toEqual({ success: false, sentCount: 0, failedCount: 2, failureReason: 'zero_delivered' });
  });

  it('transport error mid-loop — stops immediately, round fails even if some already succeeded', () => {
    // e.g. subscriber 1 succeeded, subscriber 2 hit a transport error and
    // the real loop broke out right there — subscriber 3 was never attempted.
    const outcome = computeRoundOutcome(['success'], { stoppedEarlyBy: 'transport', hadSubscribers: true });
    expect(outcome).toEqual({ success: false, sentCount: 1, failedCount: 0, failureReason: 'transport' });
  });

  it('transport error on the very first attempt — zero attempts recorded at all', () => {
    const outcome = computeRoundOutcome([], { stoppedEarlyBy: 'transport', hadSubscribers: true });
    expect(outcome).toEqual({ success: false, sentCount: 0, failedCount: 0, failureReason: 'transport' });
  });

  it('rate limited mid-loop — unchanged pre-0166 behavior, round fails', () => {
    const outcome = computeRoundOutcome(['success', 'success'], { stoppedEarlyBy: 'rate_limited', hadSubscribers: true });
    expect(outcome).toEqual({ success: false, sentCount: 2, failedCount: 0, failureReason: 'rate_limited' });
  });

  it('no subscribers at all — preserves the pre-existing behavior (round still counts as sent, 0/0)', () => {
    const outcome = computeRoundOutcome([], { hadSubscribers: false });
    expect(outcome).toEqual({ success: true, sentCount: 0, failedCount: 0, failureReason: null });
  });

  it('stoppedEarlyBy takes precedence over hadSubscribers:false — should never co-occur in practice, but transport still wins if it somehow did', () => {
    const outcome = computeRoundOutcome([], { stoppedEarlyBy: 'transport', hadSubscribers: false });
    expect(outcome.success).toBe(false);
    expect(outcome.failureReason).toBe('transport');
  });
});
