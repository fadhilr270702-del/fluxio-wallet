import { apiFetch } from './apiClient.js';

export function listAnnouncements({ status, level } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (level) params.set('level', level);
  const qs = params.toString();
  return apiFetch(`/admin/announcements${qs ? `?${qs}` : ''}`);
}

export function getAnnouncement(id) {
  return apiFetch(`/admin/announcements/${id}`);
}

export function createAnnouncement(fields) {
  return apiFetch('/admin/announcements', { method: 'POST', body: fields });
}

export function updateAnnouncement(id, fields) {
  return apiFetch(`/admin/announcements/${id}`, { method: 'PUT', body: fields });
}

export function publishAnnouncement(id) {
  return apiFetch(`/admin/announcements/${id}/publish`, { method: 'POST' });
}

export function unpublishAnnouncement(id) {
  return apiFetch(`/admin/announcements/${id}/unpublish`, { method: 'POST' });
}

export function deleteAnnouncement(id) {
  return apiFetch(`/admin/announcements/${id}`, { method: 'DELETE' });
}
