import { apiFetch } from './apiClient.js';

export function getAdmins() {
  return apiFetch('/admin/admins');
}

export function updateAdmin(id, fields) {
  return apiFetch(`/admin/admins/${id}`, { method: 'PATCH', body: fields });
}
