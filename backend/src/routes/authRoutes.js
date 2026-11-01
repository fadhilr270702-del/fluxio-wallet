import { Router } from 'express';
import { z } from 'zod';
import { login, logout, session, changePassword } from '../controllers/authController.js';
import { changePasswordSchema } from '../schemas/accountSchemas.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1)
});

export const authRoutes = Router();

// Mounted at /admin — login is the one endpoint under /admin that must NOT
// require auth (it's how you get one in the first place).
authRoutes.post('/login', validateBody(loginSchema), asyncHandler(login));
authRoutes.post('/logout', requireAuth, logout);
authRoutes.get('/session', requireAuth, session);
// Self-service — requireAuth only, deliberately no requireRole (prompt
// 0181): editors change their own password exactly like superadmins.
authRoutes.patch('/me/password', requireAuth, validateBody(changePasswordSchema), asyncHandler(changePassword));
