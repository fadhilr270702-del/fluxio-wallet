import { apiFetch } from './apiClient.js';

export function getAnalyticsSummary({ days } = {}) {
  const qs = days ? `?days=${days}` : '';
  return apiFetch(`/admin/analytics/summary${qs}`);
}
