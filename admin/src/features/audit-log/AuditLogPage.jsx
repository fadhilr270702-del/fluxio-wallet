import React, { useEffect, useState } from 'react';
import { getAuditLogs } from '../../services/auditLogApi.js';
import { formatDate } from '../../utils/formatDate.js';

const ACTION_LABELS = {
  'admin.login': 'Admin login',
  'announcement.publish': 'Announcement published',
  'broadcast.telegram.send': 'Telegram broadcast sent',
  'version.update': 'App version updated',
  'admin.updated': 'Admin role/status changed',
  // Prompt 0136 — this map was already stale (missing several
  // broadcast.telegram.* actions from prompts 0132/0134, a pre-existing gap
  // not introduced here); only the new action this prompt adds is filled
  // in, not a full backfill of the others.
  'welcome.update': 'Welcome message updated'
};

const PAGE_SIZE = 50;

export default function AuditLogPage() {
  const [logs, setLogs] = useState([]);
  const [action, setAction] = useState('');
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  function loadPage(offset, actionFilter, replace) {
    setLoading(true);
    setError(null);
    getAuditLogs({ limit: PAGE_SIZE, offset, action: actionFilter || undefined })
      .then((data) => {
        setLogs((prev) => (replace ? data.logs : [...prev, ...data.logs]));
        setHasMore(data.logs.length === PAGE_SIZE);
      })
      .catch(() => setError('Could not load the audit log.'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadPage(0, action, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action]);

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Audit Log</h1>
          <p className="page-head__desc">
            Who did what, when — logins, announcement publishes, Telegram broadcasts, version
            changes, and admin role/status changes.
          </p>
        </div>
      </div>

      <div className="toolbar">
        <div className="toolbar__filters">
          <button className={`btn btn-sm ${action === '' ? 'btn-primary' : ''}`} onClick={() => setAction('')}>
            All
          </button>
          {Object.entries(ACTION_LABELS).map(([key, label]) => (
            <button
              key={key}
              className={`btn btn-sm ${action === key ? 'btn-primary' : ''}`}
              onClick={() => setAction(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="form-error" style={{ marginBottom: 16 }}>{error}</div>}

      {logs.length === 0 && !loading ? (
        <div className="table-wrap">
          <div className="data-table__empty">No log entries yet.</div>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td className="data-table__meta">{formatDate(log.createdAt)}</td>
                  <td>{log.adminEmail}</td>
                  <td>{ACTION_LABELS[log.action] || log.action}</td>
                  <td className="data-table__meta">
                    {log.targetType ? `${log.targetType} · ${log.targetId}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {loading && <div className="loading-state">Loading…</div>}
      {!loading && hasMore && logs.length > 0 && (
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <button className="btn" onClick={() => loadPage(logs.length, action, false)}>
            Load more
          </button>
        </div>
      )}
    </main>
  );
}
