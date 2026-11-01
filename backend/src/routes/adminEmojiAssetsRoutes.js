import { Router } from 'express';
import * as controller from '../controllers/telegramEmojiAssetsController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const adminEmojiAssetsRoutes = Router();

// Same session-cookie auth as every other admin media proxy (broadcast/
// welcome preview) — see telegramEmojiAssetsController.js's own header for
// why this, not a bearer token or a signed URL.
adminEmojiAssetsRoutes.use(requireAuth);

adminEmojiAssetsRoutes.get('/:botId/:customEmojiId/thumb', asyncHandler(controller.getThumb));
adminEmojiAssetsRoutes.get('/:botId/:customEmojiId/file', asyncHandler(controller.getFile));
