import React from 'react';
import { toDatetimeLocalValue } from '../../../utils/formatDate.js';

/**
 * Fully-controlled Today/Later schedule picker — the parent owns all state
 * (mode/todayTime/laterValue), matching this codebase's plain-useState
 * style rather than introducing a stateful hook. Shared by ComposePage's
 * schedule section and RescheduleDialog so this isn't built twice; resolve
 * the final ISO via scheduleTimeHelpers.js's resolveScheduledAtIso.
 *
 * Prompt 0164 — idPrefix lets ComposePage mount a SECOND instance of this
 * same component (the recurring mode's own "Mulai pada jam tertentu"
 * picker) on the same page without colliding on the hardcoded
 * scheduleMode/scheduleTodayTime/scheduleLaterValue DOM ids — a duplicate
 * id would make a <label>'s htmlFor resolve to whichever instance's input
 * happens to come first in the DOM, silently focusing the wrong picker.
 * Defaults to the original bare ids so the pre-existing one-time-schedule
 * call site (and RescheduleDialog's) needs no change.
 */
export default function ScheduleFields({ mode, onModeChange, todayTime, onTodayTimeChange, laterValue, onLaterValueChange, idPrefix = 'schedule' }) {
  // Only a UX nudge (min attribute) — the backend re-validates "must be in
  // the future" authoritatively, this just steers the picker.
  const nowLocalValue = toDatetimeLocalValue(new Date().toISOString());
  const modeId = `${idPrefix}Mode`;
  const todayTimeId = `${idPrefix}TodayTime`;
  const laterValueId = `${idPrefix}LaterValue`;

  return (
    <div className="form-row">
      <div className="field">
        <label htmlFor={modeId}>When</label>
        <select id={modeId} value={mode} onChange={(e) => onModeChange(e.target.value)}>
          <option value="today">Today</option>
          <option value="later">Later</option>
        </select>
      </div>
      {mode === 'today' ? (
        <div className="field">
          <label htmlFor={todayTimeId}>Time</label>
          <input
            id={todayTimeId}
            type="time"
            value={todayTime}
            onChange={(e) => onTodayTimeChange(e.target.value)}
            required
          />
          <span className="field-hint">Today, your local time.</span>
        </div>
      ) : (
        <div className="field">
          <label htmlFor={laterValueId}>Date &amp; time</label>
          <input
            id={laterValueId}
            type="datetime-local"
            min={nowLocalValue}
            value={laterValue}
            onChange={(e) => onLaterValueChange(e.target.value)}
            required
          />
          <span className="field-hint">Your local time.</span>
        </div>
      )}
    </div>
  );
}
