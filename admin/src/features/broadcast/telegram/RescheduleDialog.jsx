import React, { useState } from 'react';
import Modal from '../../../components/Modal.jsx';
import ScheduleFields from './ScheduleFields.jsx';
import { resolveScheduledAtIso } from './scheduleTimeHelpers.js';
import { rescheduleTelegramBroadcast } from '../../../services/telegramBroadcastApi.js';
import { titlePlainText } from './composeRecentCards.js';

const INITIAL = { mode: 'today', todayTime: '', laterValue: '' };

/**
 * "Ubah waktu" — changes only a scheduled broadcast's send time; message
 * content is untouched (see ComposePage's separate "Edit isi" flow). A 409
 * here means the worker already started sending between opening this
 * dialog and confirming — shown inline rather than closing silently, same
 * spirit as HistoryPage's existing cancel-race handling.
 */
export default function RescheduleDialog({ broadcast, onClose, onDone }) {
  const [fields, setFields] = useState(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function handleConfirm() {
    const { iso, error: validationError } = resolveScheduledAtIso(fields);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await rescheduleTelegramBroadcast(broadcast.id, iso);
      onDone();
    } catch (err) {
      setError(err.message || 'Could not reschedule this broadcast.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Reschedule "${titlePlainText(broadcast.title, broadcast.titleFormat)}"`} onClose={onClose}>
      {error && <div className="form-error" style={{ marginBottom: 16 }}>{error}</div>}
      <ScheduleFields
        mode={fields.mode}
        onModeChange={(mode) => setFields((f) => ({ ...f, mode }))}
        todayTime={fields.todayTime}
        onTodayTimeChange={(todayTime) => setFields((f) => ({ ...f, todayTime }))}
        laterValue={fields.laterValue}
        onLaterValueChange={(laterValue) => setFields((f) => ({ ...f, laterValue }))}
      />
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={handleConfirm} disabled={submitting}>
          {submitting ? 'Saving…' : 'Save new time'}
        </button>
      </div>
    </Modal>
  );
}
