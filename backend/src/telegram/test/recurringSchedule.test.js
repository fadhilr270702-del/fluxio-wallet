import { describe, it, expect } from 'vitest';
import { isRecurringDue, computeRecurringDue } from '../recurringSchedule.js';

// Prompt 0134 Revision 1 — backend's first unit test, added specifically
// because this real duplicate-send bug's root cause (a still-NULL
// recurring_last_sent_at read as "due" by a racing worker tick) lives in
// exactly this pure comparison. Backend test infrastructure otherwise
// remains out of scope per the base prompt's own instruction — this file
// and its minimal vitest setup exist only because this one piece of logic
// is genuinely testable in isolation, not as a general precedent.
describe('isRecurringDue', () => {
  const NOW = Date.parse('2026-01-01T00:00:00.000Z');
  const ONE_HOUR = 60 * 60 * 1000;

  it('treats a null last-sent timestamp as already due (never sent yet)', () => {
    expect(isRecurringDue(null, ONE_HOUR, NOW)).toBe(true);
  });

  it('treats an undefined last-sent timestamp as already due', () => {
    expect(isRecurringDue(undefined, ONE_HOUR, NOW)).toBe(true);
  });

  it('is not due when less than the interval has elapsed', () => {
    const thirtyMinAgo = new Date(NOW - 30 * 60 * 1000).toISOString();
    expect(isRecurringDue(thirtyMinAgo, ONE_HOUR, NOW)).toBe(false);
  });

  it('is due exactly at the interval boundary (>=, not >)', () => {
    const exactlyOneHourAgo = new Date(NOW - ONE_HOUR).toISOString();
    expect(isRecurringDue(exactlyOneHourAgo, ONE_HOUR, NOW)).toBe(true);
  });

  it('is due when more than the interval has elapsed (restart catch-up case)', () => {
    const twoHoursAgo = new Date(NOW - 2 * ONE_HOUR).toISOString();
    expect(isRecurringDue(twoHoursAgo, ONE_HOUR, NOW)).toBe(true);
  });

  it('is not due one millisecond before the interval elapses', () => {
    const justUnderOneHourAgo = new Date(NOW - ONE_HOUR + 1).toISOString();
    expect(isRecurringDue(justUnderOneHourAgo, ONE_HOUR, NOW)).toBe(false);
  });

  it('defaults `now` to the real clock when not passed explicitly', () => {
    // A timestamp far in the past is due right now under the real clock,
    // regardless of what NOW is in the rest of this file's fixtures.
    expect(isRecurringDue('2000-01-01T00:00:00.000Z', ONE_HOUR)).toBe(true);
  });
});

// Prompt 0164 — the anchor-based due-check. Every fixture below is a plain
// ISO-8601 UTC string with an explicit 'Z' — this function only ever does
// millisecond-since-epoch arithmetic (Date.parse/subtraction), never any
// calendar-day or local-time reasoning, so it is inherently DST-agnostic;
// these tests prove that by construction rather than asserting it directly.
describe('computeRecurringDue', () => {
  const START = Date.parse('2026-01-01T00:00:00.000Z');
  const ONE_HOUR = 60 * 60 * 1000;
  const startIso = new Date(START).toISOString();

  it('never sent, startsAt in the future — not due yet', () => {
    const result = computeRecurringDue(null, startIso, ONE_HOUR, START - 1000);
    expect(result).toEqual({ due: false, anchorForThisRound: startIso });
  });

  it('never sent, exactly at startsAt — due (>=, not >)', () => {
    const result = computeRecurringDue(null, startIso, ONE_HOUR, START);
    expect(result).toEqual({ due: true, anchorForThisRound: startIso });
  });

  it('never sent, startsAt null — due right now (the "Mulai sekarang" / legacy case, identical to isRecurringDue\'s own null-lastSent rule)', () => {
    const result = computeRecurringDue(null, null, ONE_HOUR, START);
    expect(result).toEqual({ due: true, anchorForThisRound: null });
  });

  it('normal slot — due exactly one interval after the anchor, once the first round landed exactly on the anchor', () => {
    const firstSend = startIso; // round 1 landed exactly on the anchor
    const beforeSlot2 = computeRecurringDue(firstSend, startIso, ONE_HOUR, START + ONE_HOUR - 1);
    expect(beforeSlot2.due).toBe(false);
    const atSlot2 = computeRecurringDue(firstSend, startIso, ONE_HOUR, START + ONE_HOUR);
    expect(atSlot2).toEqual({ due: true, anchorForThisRound: new Date(START + ONE_HOUR).toISOString() });
  });

  it('normal slot stays pinned to the anchor even when the last send landed a little late (no drift)', () => {
    // Round 1 was due at START but the worker tick / network delay meant it
    // actually sent 90 seconds late — round 2 must still be due at
    // START + 1h, not (START + 90s) + 1h, proving slots are computed from
    // the anchor, never from the last actual send time.
    const lateFirstSend = new Date(START + 90 * 1000).toISOString();
    const result = computeRecurringDue(lateFirstSend, startIso, ONE_HOUR, START + ONE_HOUR);
    expect(result).toEqual({ due: true, anchorForThisRound: new Date(START + ONE_HOUR).toISOString() });
  });

  it('catch-up: several slots missed entirely — sends exactly ONE round now, next slot sticks to the next regular anchor boundary, not a burst', () => {
    // Anchor at START, 1h interval. Round 1 sent at START. Worker then goes
    // down until START + 3.5h — slots at +1h, +2h, +3h were all missed.
    const firstSend = startIso;
    const resumeAt = START + 3.5 * ONE_HOUR;
    const catchUp = computeRecurringDue(firstSend, startIso, ONE_HOUR, resumeAt);
    // Due now (catching up to the +1h slot, the earliest unfulfilled one) —
    // the actual missed slots (+1h/+2h/+3h) are never individually visited.
    expect(catchUp.due).toBe(true);
    // Simulate that catch-up round actually sending at resumeAt (matching
    // recordRecurringSend's own "stamp the REAL send time" contract).
    const afterCatchUp = new Date(resumeAt).toISOString();
    // The NEXT slot after a send at +3.5h is +4h (the next regular anchor
    // boundary), not +4.5h (which "last send + interval" drift-based math
    // would produce) and not +2h/+3h (which would mean a burst of
    // still-pending catch-up sends).
    const nextCheck = computeRecurringDue(afterCatchUp, startIso, ONE_HOUR, resumeAt + 1);
    expect(nextCheck).toEqual({ due: false, anchorForThisRound: new Date(START + 4 * ONE_HOUR).toISOString() });
    const atNextSlot = computeRecurringDue(afterCatchUp, startIso, ONE_HOUR, START + 4 * ONE_HOUR);
    expect(atNextSlot.due).toBe(true);
  });

  it('fallback for a legacy row with no anchor at all (already sent, startsAt still null) — identical to isRecurringDue\'s own plain elapsed-time rule', () => {
    const thirtyMinAgo = new Date(START - 30 * 60 * 1000).toISOString();
    const notDue = computeRecurringDue(thirtyMinAgo, null, ONE_HOUR, START);
    expect(notDue).toEqual({ due: false, anchorForThisRound: null });

    const oneHourAgo = new Date(START - ONE_HOUR).toISOString();
    const due = computeRecurringDue(oneHourAgo, null, ONE_HOUR, START);
    expect(due).toEqual({ due: true, anchorForThisRound: null });
  });

  it('a 24-hour interval works identically to any other interval — no special-casing needed', () => {
    const TWENTY_FOUR_HOURS = 24 * ONE_HOUR;
    const firstSend = startIso;
    const notDue = computeRecurringDue(firstSend, startIso, TWENTY_FOUR_HOURS, START + TWENTY_FOUR_HOURS - 1);
    expect(notDue.due).toBe(false);
    const due = computeRecurringDue(firstSend, startIso, TWENTY_FOUR_HOURS, START + TWENTY_FOUR_HOURS);
    expect(due).toEqual({ due: true, anchorForThisRound: new Date(START + TWENTY_FOUR_HOURS).toISOString() });
  });
});
