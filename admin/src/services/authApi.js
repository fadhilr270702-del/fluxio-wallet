import { apiFetch } from './apiClient.js';

export function login(email, password) {
  return apiFetch('/admin/login', { method: 'POST', body: { email, password } });
}

export function logout() {
  return apiFetch('/admin/logout', { method: 'POST' });
}

/** Boot-time / route-guard check — resolves {admin} or throws ApiError(401) if no valid session. */
export function fetchSession() {
  return apiFetch('/admin/session');
}

/**
 * Self-service change password (prompt 0181). 204 on success — the backend
 * keeps THIS session alive and revokes every other one, so no re-login.
 */
export function changePassword(currentPassword, newPassword) {
  return apiFetch('/admin/me/password', { method: 'PATCH', body: { currentPassword, newPassword } });
}
