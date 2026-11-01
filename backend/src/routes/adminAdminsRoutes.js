import { Router } from 'express';
import { z } from 'zod';
import * as controller from '../controllers/adminAdminsController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireRole } from '../middleware/requireRole.js';
import { validateBody } from '../middleware/validate.js';

const updateAdminSchema = z
  .object({
    role: z.enum(['superadmin', 'editor']).optional(),
    isActive: z.boolean().optional()
  })
  .refine((data) => data.role !== undefined || data.isActive !== undefined, {
    message: 'At least one of role or isActive is required.'
  });

export const adminAdminsRoutes = Router();

// requireRole must run after requireAuth — see middleware/requireRole.js.
adminAdminsRoutes.use(requireAuth);
adminAdminsRoutes.use(requireRole('superadmin'));

adminAdminsRoutes.get('/', controller.list);
adminAdminsRoutes.patch('/:id', validateBody(updateAdminSchema), controller.update);
