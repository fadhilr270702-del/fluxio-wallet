import React, { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import useAuth from '../../hooks/useAuth.js';
import { ApiError } from '../../services/apiClient.js';

export default function Login() {
  const { admin, login } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Already logged in (e.g. visited /login directly) — bounce to wherever
  // ProtectedRoute originally redirected from, or the dashboard.
  if (admin) {
    return <Navigate to={location.state?.from?.pathname || '/dashboard'} replace />;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message || 'Incorrect email or password.' : 'Could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-card__logo-wrap">
          <img src="/logo.png" alt="Fluxio" className="login-card__logo" />
        </div>
        <div className="login-card__brand">
          <span>Fluxio <span style={{ color: 'var(--gold)' }}>Admin</span></span>
        </div>
        <h1>Sign in</h1>
        <p>Internal panel — announcements and operations. Non-custodial: no wallet secrets live here.</p>

        <form className="form-grid" onSubmit={handleSubmit}>
          {error && <div className="form-error">{error}</div>}
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
