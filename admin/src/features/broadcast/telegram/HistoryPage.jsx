import React, { useCallback, useEffect, useState } from 'react';
import BroadcastTabs from './BroadcastTabs.jsx';
import BroadcastHistoryTable from './BroadcastHistoryTable.jsx';
import RescheduleDialog from './RescheduleDialog.jsx';
import { listTelegramBroadcasts, cancelTelegramBroadcast } from '../../../services/telegramBroadcastApi.js';
import useBotContext from '../../../hooks/useBotContext.js';

export default function HistoryPage() {
  const { botId } = useBotContext();
  const [broadcasts, setBroadcasts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reschedulingId, setReschedulingId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    listTelegramBroadcasts({ bot: botId })
      .then((data) => setBroadcasts(data.broadcasts))
      .catch(() => setError('Could not load broadcast history.'))
      .finally(() => setLoading(false));
  }, [botId]);

  // Prompt 0139 — re-runs whenever the switcher changes bot context, so
  // History always shows whichever bot is currently selected. No dirty-
  // form guard needed here (this page has no form of its own to protect —
  // see BotContext.jsx's own comment on why non-registering pages are
  // always frictionless to switch away from).
  useEffect(() => {
    load();
  }, [load]);

  async function handleCancel(id) {
    if (!window.confirm('Cancel this scheduled broadcast? It will not be sent.')) return;
    setError(null);
    try {
      await cancelTelegramBroadcast(id);
      load();
    } catch (err) {
      // Most likely the worker just activated it (or someone else already
      // canceled it) — re-fetch so the row reflects its real current status.
      setError(err.message || 'Could not cancel this broadcast.');
      load();
    }
  }

  const reschedulingBroadcast = broadcasts.find((b) => b.id === reschedulingId) || null;

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Broadcast — Telegram</h1>
          <p className="page-head__desc">Past broadcasts, most recent first.</p>
        </div>
      </div>

      <BroadcastTabs />

      {error && <div className="form-error" style={{ marginBottom: 16 }}>{error}</div>}

      {loading ? (
        <div className="loading-state">Loading…</div>
      ) : (
        <BroadcastHistoryTable broadcasts={broadcasts} onCancel={handleCancel} onReschedule={setReschedulingId} />
      )}

      {reschedulingBroadcast && (
        <RescheduleDialog
          broadcast={reschedulingBroadcast}
          onClose={() => setReschedulingId(null)}
          onDone={() => {
            setReschedulingId(null);
            load();
          }}
        />
      )}
    </main>
  );
}
