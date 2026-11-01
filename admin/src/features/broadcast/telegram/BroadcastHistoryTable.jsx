import React from 'react';
import { Link } from 'react-router-dom';
import Badge from '../../../components/Badge.jsx';
import { formatDate } from '../../../utils/formatDate.js';
import { TARGET_TYPE_LABELS, progressLabel, recurringProgressLabel } from './telegramBroadcastStatus.js';
import FormattedTelegramText from './FormattedTelegramText.jsx';
import { DataBotProvider } from '../../../app/DataBotContext.jsx';

export default function BroadcastHistoryTable({ broadcasts, onCancel, onReschedule }) {
  if (broadcasts.length === 0) {
    return (
      <div className="table-wrap">
        <div className="data-table__empty">No broadcasts sent yet.</div>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Target</th>
            <th>Status</th>
            <th>Progress</th>
            <th>Scheduled for</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {/* Prompt 0161 — one <DataBotProvider value={b.bot}> per row: a
              plain Context.Provider renders no DOM element of its own, so
              wrapping <tr> directly (not each individual <td>) is valid,
              and correctly resolves each row's own premium-emoji title
              content against THAT broadcast's own bot, never whichever
              bot the switcher happens to show right now — different rows
              in the same table could in principle belong to different
              bots, even though today's own filtering never actually
              mixes them in one render. */}
          {broadcasts.map((b) => (
            <DataBotProvider key={b.id} value={b.bot}>
              <tr>
                <td>
                  <div className="data-table__title">
                    <FormattedTelegramText text={b.title} format={b.titleFormat} />
                  </div>
                </td>
              <td>
                {TARGET_TYPE_LABELS[b.targetType]}
                {b.targetType === 'channel' && <div className="data-table__meta">{b.targetChannelId}</div>}
              </td>
              <td><Badge value={b.status} kind="broadcastStatus" /></td>
              <td className="data-table__meta">
                {/* Prompt 0134 — a recurring broadcast's own "Sent N×, last
                    HH:MM" tally takes priority over the normal per-recipient
                    progress shape; recurringProgressLabel returns null for
                    every broadcast that was never recurring, so this falls
                    through to the existing behavior unchanged for those. */}
                {recurringProgressLabel(b) ?? (b.targetType === 'subscribers' ? progressLabel(b) : `${b.sentCount}/${b.totalCount} sent`)}
              </td>
              <td className="data-table__meta">{b.scheduledAt ? formatDate(b.scheduledAt) : '—'}</td>
              <td className="data-table__meta">{formatDate(b.createdAt)}</td>
              <td>
                <div className="data-table__actions">
                  {b.status === 'scheduled' && (
                    <>
                      <Link className="btn btn-sm" to={`/broadcast/telegram/${b.id}/edit`}>Edit isi</Link>
                      <button className="btn btn-sm" onClick={() => onReschedule(b.id)}>Ubah waktu</button>
                      <button className="btn btn-sm btn-danger" onClick={() => onCancel(b.id)}>Cancel</button>
                    </>
                  )}
                  {/* Prompt 0134 — content editing stays reachable while a
                      broadcast is actively recurring (the backend already
                      allows this; see updateContent's own comment), but
                      Ubah waktu/Cancel don't apply to a recurring broadcast
                      at all (no schedule to change or cancel) — deactivating
                      it happens from its card or its detail page instead,
                      deliberately not duplicated here as a third action in
                      this already-busy row. */}
                  {b.status === 'recurring' && (
                    <Link className="btn btn-sm" to={`/broadcast/telegram/${b.id}/edit`}>Edit isi</Link>
                  )}
                  <Link className="btn btn-sm" to={`/broadcast/history/${b.id}`}>View</Link>
                </div>
              </td>
            </tr>
            </DataBotProvider>
          ))}
        </tbody>
      </table>
    </div>
  );
}
