import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import useAuth from '../hooks/useAuth.js';
import AppShell from './AppShell.jsx';

/**
 * Guards every admin route except /login. Waits for the initial
 * GET /admin/session check (see AuthContext.jsx) before deciding — without
 * that, a logged-in admin doing a hard refresh would flash a redirect to
 * /login before the session check resolves.
 */
export default function ProtectedRoute({ children }) {
  const { admin, initializing } = useAuth();
  const location = useLocation();

  if (initializing) {
    return <div className="loading-state">Loading…</div>;
  }
  if (!admin) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <AppShell>{children}</AppShell>;
}
