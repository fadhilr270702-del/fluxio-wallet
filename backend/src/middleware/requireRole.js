/**
 * Role gate, layered on top of requireAuth (must run after it, so
 * `req.admin` is already set). Not wired into any route in this slice —
 * every protected route currently only needs "any authenticated admin" —
 * but written and ready so a future slice can do
 * `router.delete('/:id', requireAuth, requireRole('superadmin'), ...)`
 * without inventing this piece from scratch under time pressure.
 */
import { HttpError } from '../utils/httpError.js';

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.admin) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'requireRole used without requireAuth running first.');
    }
    if (!allowedRoles.includes(req.admin.role)) {
      throw new HttpError(403, 'FORBIDDEN', `Requires one of role(s): ${allowedRoles.join(', ')}.`);
    }
    next();
  };
}
