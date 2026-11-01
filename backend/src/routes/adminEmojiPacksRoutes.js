import { Router } from 'express';
import { z } from 'zod';
import * as controller from '../controllers/telegramEmojiPacksController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const registerSchema = z.object({
  bot: z.string().trim().optional(),
  // Shape-only here (matches this codebase's existing "loose shape in zod,
  // real check in the controller" split, e.g. mediaServerFilename) — the
  // actual link-vs-plain-name parsing and the strict
  // ^[A-Za-z0-9_]{1,64}$ allowlist live in emojiPackName.js, since that
  // logic is worth its own direct unit tests independent of this route.
  input: z.string().trim().min(1, 'Enter a pack link or name.')
});

const refreshSchema = z.object({ bot: z.string().trim().optional() });

export const adminEmojiPacksRoutes = Router();

// Same access level as every other broadcast-area setting (Compose,
// History, Welcome) — requireAuth only, no requireRole. This is
// deliberately NOT superadmin-gated like Versions/Admins/Audit Log.
adminEmojiPacksRoutes.use(requireAuth);

adminEmojiPacksRoutes.get('/', controller.list);
adminEmojiPacksRoutes.post('/', validateBody(registerSchema), asyncHandler(controller.register));
// Prompt 0153 — a 3-segment literal-prefixed path, never ambiguous with
// the 2-segment `/:id/emojis` below regardless of declaration order
// (Express matches on segment shape, not just prefix).
adminEmojiPacksRoutes.get('/lookup/:botId/:customEmojiId', controller.lookupEmoji);
adminEmojiPacksRoutes.get('/:id/emojis', controller.listEmojis);
adminEmojiPacksRoutes.post('/:id/refresh', validateBody(refreshSchema), asyncHandler(controller.refresh));
adminEmojiPacksRoutes.delete('/:id', controller.remove);
