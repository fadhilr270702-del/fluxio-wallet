import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../../components/Icon.jsx';
import AnnouncementTable from './AnnouncementTable.jsx';
import {
  listAnnouncements,
  publishAnnouncement,
  unpublishAnnouncement,
  deleteAnnouncement
} from '../../services/announcementsApi.js';

const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' }
];

export default function AnnouncementsPage() {
  const [announcements, setAnnouncements] = useState([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listAnnouncements({ status: status || undefined })
      .then((data) => setAnnouncements(data.announcements))
      .catch(() => setError('Could not load announcements.'))
      .finally(() => setLoading(false));
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  async function handlePublish(id) {
    await publishAnnouncement(id);
    load();
  }

  async function handleUnpublish(id) {
    await unpublishAnnouncement(id);
    load();
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this announcement? This cannot be undone.')) return;
    await deleteAnnouncement(id);
    load();
  }

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Announcements</h1>
          <p className="page-head__desc">
            One-way broadcast content shown to wallet users. No reader tracking — publishing an
            announcement never records who saw it.
          </p>
        </div>
      </div>

      <div className="toolbar">
        <div className="toolbar__filters">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              className={`btn btn-sm ${status === f.value ? 'btn-primary' : ''}`}
              onClick={() => setStatus(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <Link className="btn btn-sm btn-primary" to="/announcements/new">
          <Icon name="plus" /> New announcement
        </Link>
      </div>

      {error && <div className="form-error" style={{ marginBottom: 16 }}>{error}</div>}

      {loading ? (
        <div className="loading-state">Loading…</div>
      ) : (
        <AnnouncementTable
          announcements={announcements}
          onPublish={handlePublish}
          onUnpublish={handleUnpublish}
          onDelete={handleDelete}
        />
      )}
    </main>
  );
}
