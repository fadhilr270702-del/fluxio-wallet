// @vitest-environment jsdom
/**
 * Prompt 0246 — the schedule section of the Edit page for a recurring
 * broadcast, rendered and driven for real (jsdom + testing-library, the
 * errorBoundary.test.jsx setup): the two inputs, the exact hint text, and
 * the full path from "the admin changes the inputs" to "the Save request
 * body", through the same two functions ComposePage itself calls
 * (resolveRecurringScheduleEdit + applyScheduleEditToPayload).
 *
 * ComposePage as a whole is not mounted here: it needs the router, the
 * bot context and two TipTap editors, none of which this feature touches.
 */
import React, { useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import RecurringScheduleFields from '../RecurringScheduleFields.jsx';
import { initialScheduleEditState, resolveRecurringScheduleEdit, applyScheduleEditToPayload } from '../recurringScheduleEdit.js';

afterEach(cleanup);

const NOW = new Date(2026, 10, 16, 12, 0, 0).getTime();
// The API shape of an active recurring broadcast, as GET /:id returns it.
const BROADCAST = {
  status: 'recurring',
  recurringIntervalHours: 24,
  recurringNextRoundAt: new Date(2026, 10, 17, 6, 0, 0).toISOString()
};
const CONTENT_PAYLOAD = {
  title: '<b>Who holds your crypto?</b>',
  titleFormat: 'html',
  body: 'Your keys, your crypto.',
  bodyFormat: 'html',
  mediaUrl: null,
  mediaFileId: null,
  mediaServerFilename: null,
  mediaType: null,
  buttons: [{ text: 'GET FLUXIO', url: 'https://fluxiowallet.com', iconCustomEmojiId: null }]
};

/** The same wiring ComposePage has: original state kept, current state edited, payload built on submit. */
function Harness({ onSubmit }) {
  const [original] = useState(() => initialScheduleEditState(BROADCAST, NOW));
  const [current, setCurrent] = useState(original);
  const [error, setError] = useState(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const resolved = resolveRecurringScheduleEdit({ original, current, now: NOW });
        if (resolved.error) {
          setError(resolved.error);
          return;
        }
        setError(null);
        onSubmit(applyScheduleEditToPayload(CONTENT_PAYLOAD, resolved));
      }}
    >
      <RecurringScheduleFields
        intervalHours={current.intervalHours}
        onIntervalHoursChange={(intervalHours) => setCurrent((c) => ({ ...c, intervalHours }))}
        nextRoundLocal={current.nextRoundLocal}
        onNextRoundLocalChange={(nextRoundLocal) => setCurrent((c) => ({ ...c, nextRoundLocal }))}
      />
      {error && <div role="alert">{error}</div>}
      <button type="submit">Save changes</button>
    </form>
  );
}

describe('RecurringScheduleFields (0246)', () => {
  it('renders the two inputs prefilled from the broadcast, and the exact hint text', () => {
    render(<Harness onSubmit={() => {}} />);
    const interval = screen.getByLabelText('Interval (hours)');
    expect(interval.type).toBe('number');
    expect(interval.value).toBe('24');
    expect(interval.min).toBe('1');
    expect(interval.max).toBe('168');
    const nextRound = screen.getByLabelText('Next round');
    expect(nextRound.type).toBe('datetime-local');
    expect(nextRound.value).toBe('2026-11-17T06:00');
    // No `min` and not `required`: the browser's own validation must never
    // block a content only save over an untouched schedule section.
    expect(nextRound.min).toBe('');
    expect(nextRound.required).toBe(false);
    expect(interval.required).toBe(false);
    expect(screen.getByText('Schedule changes apply from the next round. The round in progress finishes first.')).toBeTruthy();
    expect(screen.queryByText(/unchanged by this edit/)).toBeNull();
  });

  it('saving without touching the schedule submits the content payload alone', () => {
    const submitted = [];
    render(<Harness onSubmit={(payload) => submitted.push(payload)} />);
    fireEvent.click(screen.getByText('Save changes'));
    expect(submitted).toEqual([CONTENT_PAYLOAD]);
    expect('intervalHours' in submitted[0]).toBe(false);
    expect('nextRunAt' in submitted[0]).toBe(false);
  });

  it('changing both inputs submits content and schedule together: intervalHours as a number, nextRunAt as UTC ISO', () => {
    const submitted = [];
    render(<Harness onSubmit={(payload) => submitted.push(payload)} />);
    fireEvent.change(screen.getByLabelText('Interval (hours)'), { target: { value: '72' } });
    fireEvent.change(screen.getByLabelText('Next round'), { target: { value: '2026-11-19T18:30' } });
    fireEvent.click(screen.getByText('Save changes'));
    expect(submitted).toEqual([
      { ...CONTENT_PAYLOAD, intervalHours: 72, nextRunAt: new Date(2026, 10, 19, 18, 30).toISOString() }
    ]);
  });

  it('a next round in the past is stopped on the page with a clear message and nothing is submitted', () => {
    const submitted = [];
    render(<Harness onSubmit={(payload) => submitted.push(payload)} />);
    fireEvent.change(screen.getByLabelText('Next round'), { target: { value: '2026-11-16T09:00' } });
    fireEvent.click(screen.getByText('Save changes'));
    expect(submitted).toEqual([]);
    expect(screen.getByRole('alert').textContent).toBe('The next round must be in the future.');
  });
});
