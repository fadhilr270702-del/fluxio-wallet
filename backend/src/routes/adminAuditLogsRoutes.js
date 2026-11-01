import { Router } from 'express';
import * as controller from '../controllers/adminAuditLogsController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireRole } from '../middleware/requireRole.js';

export const adminAuditLogsRoutes = Router();

// requireRole must run after requireAuth — see middleware/requireRole.js.
// Viewing what other admins have done is itself an oversight capability,
// so this is superadmin-only, not just any authenticated admin.
adminAuditLogsRoutes.use(requireAuth);
adminAuditLogsRoutes.use(requireRole('superadmin'));

adminAuditLogsRoutes.get('/', controller.list);
