import { useContext } from 'react';
import { AuthContext } from '../app/AuthContext.jsx';

/**
 * Reads the current admin session + login()/logout() from AuthContext.
 * Split into its own file (rather than exporting a hook from AuthContext.jsx
 * directly) purely so consumers don't also drag the Provider/context object
 * into their import — keeps "which component owns the state" unambiguous.
 */
export default function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth() must be used within <AuthProvider>');
  return ctx;
}
