/**
 * Zod schema for the self-service change-password endpoint
 * (PATCH /admin/me/password, prompt 0181). Lives here — not in the route
 * file — per prompt 0167's lesson: schema modules carry zero database
 * dependency, so a schema-only test never has a reason to import a route.
 *
 * The 8-char minimum mirrors scripts/createAdmin.js's own floor (the only
 * other place a password is ever set), so the two paths can't drift apart
 * silently. `currentPassword` is min(1) only — its real check is bcrypt
 * verification in the controller, not shape validation here.
 */
import { z } from 'zod';

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required.'),
    newPassword: z.string().min(8, 'New password must be at least 8 characters.')
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    path: ['newPassword'],
    message: 'New password must be different from the current password.'
  });
