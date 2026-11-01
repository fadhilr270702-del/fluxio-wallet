import React from 'react';
import { Link } from 'react-router-dom';
import Badge from '../../components/Badge.jsx';
import Icon from '../../components/Icon.jsx';
import FormattedRichText from '../../components/FormattedRichText.jsx';
import { formatDate } from '../../utils/formatDate.js';
import { scheduleHint, targetPlatformLabel } from './announcementsStatus.js';

export default function AnnouncementTable({ announcements, onPublish, onUnpublish, onDelete }) {
  if (announcements.length === 0) {
    return (
      <div className="table-wrap">
        <div className="data-table__empty">No announcements yet. Create one to get started.</div>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Level</th>
            <th>Status</th>
            <th>Target</th>
            <th>Schedule</th>
            <th>Updated</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {announcements.map((a) => {
            const hint = scheduleHint(a);
            return (
              <tr key={a.id}>
                <td>
                  <div className="data-table__title">
                    <FormattedRichText text={a.title} format={a.titleFormat} />
                  </div>
                  {hint && <div className="data-table__meta">{hint}</div>}
                </td>
                <td><Badge value={a.level} kind="level" /></td>
                <td><Badge value={a.status} kind="status" /></td>
                <td>{targetPlatformLabel(a.targetPlatform)}</td>
                <td className="data-table__meta">
                  {a.startsAt || a.endsAt
                    ? `${formatDate(a.startsAt)} → ${formatDate(a.endsAt)}`
                    : 'Always'}
                </td>
                <td className="data-table__meta">{formatDate(a.updatedAt)}</td>
                <td>
                  <div className="data-table__actions">
                    {a.status === 'draft' ? (
                      <button className="btn btn-sm" onClick={() => onPublish(a.id)}>Publish</button>
                    ) : (
                      <button className="btn btn-sm" onClick={() => onUnpublish(a.id)}>Unpublish</button>
                    )}
                    <Link className="btn btn-sm" to={`/announcements/${a.id}/edit`}>
                      Edit
                    </Link>
                    <button className="btn btn-sm btn-danger" onClick={() => onDelete(a.id)}>
                      <Icon name="trash" className="icon" /> Delete
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
