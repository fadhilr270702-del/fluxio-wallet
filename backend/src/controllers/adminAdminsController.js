/**
 * Admin-account management — superadmin-only (see routes/adminAdminsRoutes.js's
 * requireRole('superadmin')). Doesn't create or delete admin accounts —
 * only lists them and toggles role/active status on an existing one. The
 * only way to create the first (or any additional) admin remains
 * scripts/createAdmin.js, unchanged from Slice 1.
 */
import { listAdmins, findAdminByIdAny, updateAdmin } from '../db/repositories/adminsRepo.js';
import { recordAuditLog } from '../db/repositories/auditLogsRepo.js';
import { HttpError } from '../utils/httpError.js';

function toApiShape(admin) {
  return {
    id: admin.id,
    email: admin.email,
    role: admin.role,
    isActive: Boolean(admin.is_active),
    createdAt: admin.created_at,
    updatedAt: admin.updated_at
  };
}

export function list(req, res) {
  res.json({ admins: listAdmins().map(toApiShape) });
}

export function update(req, res) {
  const { id } = req.params;
  const target = findAdminByIdAny(id);
  if (!target) throw new HttpError(404, 'NOT_FOUND', 'Admin not found.');

  // The one structural guard against ending up with zero active
  // superadmins: acting on someone else's role always leaves the acting
  // superadmin untouched, so this check alone is sufficient.
  if (id === req.admin.id) {
    throw new HttpError(400, 'CANNOT_MODIFY_SELF', 'Use a different superadmin account to change your own role or active status.');
  }

  const { role, isActive } = req.body;
  const updated = updateAdmin(id, { role, isActive });

  recordAuditLog({
    adminId: req.admin.id,
    action: 'admin.updated',
    targetType: 'admin',
    targetId: id,
    metadata: { role, isActive }
  });

  res.json({ admin: toApiShape(updated) });
}
