import { apiFetch } from './apiClient.js';

export function getVersions() {
  return apiFetch('/admin/versions');
}

export function updatePlatformVersion(platform, fields) {
  return apiFetch(`/admin/versions/${platform}`, { method: 'PUT', body: fields });
}
