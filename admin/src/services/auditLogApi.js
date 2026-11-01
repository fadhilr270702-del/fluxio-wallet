import { apiFetch } from './apiClient.js';

export function getAuditLogs({ limit, offset, action } = {}) {
  const params = new URLSearchParams();
  if (limit) params.set('limit', limit);
  if (offset) params.set('offset', offset);
  if (action) params.set('action', action);
  const qs = params.toString();
  return apiFetch(`/admin/audit-logs${qs ? `?${qs}` : ''}`);
}
