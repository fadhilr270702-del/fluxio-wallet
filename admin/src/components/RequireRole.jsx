import React from 'react';
import useAuth from '../hooks/useAuth.js';

/**
 * Role gate for a route's content — nested inside <ProtectedRoute> (which
 * already guarantees `admin` is non-null; this only adds the role check on
 * top). Renders a plain "Access denied" message rather than redirecting —
 * a direct, honest response to hitting a route your role can't use, not a
 * surprise navigation. Sidebar.jsx also hides these routes' nav links
 * entirely for a role that can't use them — this is the backstop for
 * someone typing the URL directly.
 */
export default function RequireRole({ roles, children }) {
  const { admin } = useAuth();

  if (!admin || !roles.includes(admin.role)) {
    return (
      <div className="access-denied">
        <h1>Access denied</h1>
        <p>Your role ({admin?.role ?? 'unknown'}) doesn't have access to this page.</p>
      </div>
    );
  }

  return children;
}
