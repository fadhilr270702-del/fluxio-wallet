import React from 'react';
import { MAX_RECURRING_INTERVAL_HOURS } from './recurringScheduleEdit.js';

/**
 * Prompt 0246 — the schedule section of the Edit page for an ACTIVE
 * recurring broadcast: how often it repeats and when the next round goes
 * out. Fully controlled (the parent owns both values as the raw strings
 * the inputs hold), same style as ScheduleFields.jsx; what a change means
 * for the Save request is decided by recurringScheduleEdit.js's
 * resolveRecurringScheduleEdit, not here.
 *
 * Neither input is `required`, and Next round deliberately carries NO
 * `min` attribute (unlike ScheduleFields' picker): an untouched section
 * must stay submittable even when the next round has no future value to
 * show (a round is in progress) or when the prefilled time has passed
 * while the page sat open. A `min` would let the browser's own validation
 * block the whole form in exactly that case, including a content only
 * save — caught by composePageEditSchedule.test.jsx. A past time on a
 * CHANGED schedule is refused by resolveRecurringScheduleEdit with the
 * page's own message, and again by the backend.
 */
export default function RecurringScheduleFields({ intervalHours, onIntervalHoursChange, nextRoundLocal, onNextRoundLocalChange, idPrefix = 'recurringEdit' }) {
  const intervalId = `${idPrefix}IntervalHours`;
  const nextRoundId = `${idPrefix}NextRound`;

  return (
    <>
      <div className="form-row">
        <div className="field">
          <label htmlFor={intervalId}>Interval (hours)</label>
          <input
            id={intervalId}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_RECURRING_INTERVAL_HOURS}
            step={1}
            value={intervalHours}
            onChange={(e) => onIntervalHoursChange(e.target.value)}
          />
          <span className="field-hint">A whole number from 1 to {MAX_RECURRING_INTERVAL_HOURS}.</span>
        </div>
        <div className="field">
          <label htmlFor={nextRoundId}>Next round</label>
          <input
            id={nextRoundId}
            type="datetime-local"
            value={nextRoundLocal}
            onChange={(e) => onNextRoundLocalChange(e.target.value)}
          />
          <span className="field-hint">Your local time.</span>
        </div>
      </div>
      <p className="field-hint">Schedule changes apply from the next round. The round in progress finishes first.</p>
    </>
  );
}
