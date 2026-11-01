import { Router } from 'express';
import * as controller from '../controllers/adminVersionsController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireRole } from '../middleware/requireRole.js';
import { validateBody } from '../middleware/validate.js';
// Prompt 0167 — the zod schema moved to schemas/versionSchemas.js, a
// module with zero database dependency — see that module's own header, and
// announcementSchemas.js's own header, for the full reasoning.
import { updateVersionSchema } from '../schemas/versionSchemas.js';

export const adminVersionsRoutes = Router();

// Every route in this router requires an authenticated admin session —
// mounted once here rather than repeated per-handler (see requireAuth.js).
adminVersionsRoutes.use(requireAuth);
// A misconfigured minimum version can force-update or lock out every user
// on a platform — superadmin-only, same "sensitive setting" bar as admin
// account management and the audit log (see CLAUDE.md's Slice 5 bullet).
adminVersionsRoutes.use(requireRole('superadmin'));

adminVersionsRoutes.get('/', controller.list);
adminVersionsRoutes.put('/:platform', validateBody(updateVersionSchema), controller.update);
