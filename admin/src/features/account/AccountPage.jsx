import React, { useState } from 'react';
import useAuth from '../../hooks/useAuth.js';
import { changePassword } from '../../services/authApi.js';
import { ApiError } from '../../services/apiClient.js';
import { validateChangePassword } from './changePasswordValidation.js';

/**
 * /account — self-service "My Account" page (prompt 0181). Reachable by
 * EVERY authenticated admin: plain ProtectedRoute, deliberately no
 * RequireRole (editors need to change their own password exactly as much
 * as superadmins — unlike /settings, which is superadmin-only admin
 * MANAGEMENT of other people's accounts). Plain password inputs only — no
 * rich text/emoji anywhere near this form, by explicit instruction.
 */
export default function AccountPage() {
  const { admin } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    const clientError = validateChangePassword({ currentPassword, newPassword, confirmPassword });
    if (clientError) {
      setError(clientError);
      return;
    }

    setSubmitting(true);
    try {
      await changePassword(currentPassword, newPassword);
      // Backend kept THIS session alive and revoked every other one — so
      // stay logged in, clear the form, and say what just happened.
      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.code === 'INVALID_CREDENTIALS'
            ? 'Current password is incorrect.'
            : err.message || 'Could not change the password.'
        );
      } else {
        setError('Could not reach the server.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>My Account</h1>
          <p className="page-head__desc">
            Signed in as <strong>{admin?.email}</strong> ({admin?.role}).
          </p>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 480, padding: 22 }}>
        <h2 style={{ marginTop: 0 }}>Change password</h2>
        <form className="form-grid" onSubmit={handleSubmit}>
          {error && <div className="form-error">{error}</div>}
          {success && (
            <div className="form-success">
              Password changed. All your other devices have been signed out — this session stays logged in.
            </div>
          )}
          <div className="field">
            <label htmlFor="current-password">Current password</label>
            <input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="new-password">New password</label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="confirm-password">Confirm new password</label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </form>
      </div>
    </div>
  );
}
