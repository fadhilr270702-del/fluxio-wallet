import React, { createContext, useCallback, useEffect, useState } from 'react';
import { fetchSession, login as loginRequest, logout as logoutRequest } from '../services/authApi.js';

export const AuthContext = createContext(null);

/**
 * Owns the single source of truth for "who is logged in" — a GET
 * /admin/session call on mount (relying on the httpOnly cookie, not any
 * client-stored token) tells us whether a session already exists, e.g.
 * after a hard refresh. `initializing` lets ProtectedRoute/Login avoid
 * redirect flicker while that first check is in flight.
 */
export function AuthProvider({ children }) {
  const [admin, setAdmin] = useState(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchSession()
      .then((data) => {
        if (!cancelled) setAdmin(data.admin);
      })
      .catch(() => {
        if (!cancelled) setAdmin(null);
      })
      .finally(() => {
        if (!cancelled) setInitializing(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email, password) => {
    const data = await loginRequest(email, password);
    setAdmin(data.admin);
    return data.admin;
  }, []);

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } finally {
      setAdmin(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ admin, initializing, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
