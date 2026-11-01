/**
 * Admin endpoints for the /start welcome message (prompt 0136, extended by
 * 0137 with video upload + version-history routes). Mirrors
 * adminTelegramBroadcastRoutes.js's own patterns throughout — same
 * requireAuth-once-for-the-router mount, same broadcastButtonSchema-style
 * https://-only button validation, same html-body sanitize-at-write-time
 * approach, same separate image/video multer instances — deliberately not
 * re-deriving any of these from scratch.
 */
import { Router } from 'express';
import multer from 'multer';
import * as controller from '../controllers/welcomeController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { HttpError } from '../utils/httpError.js';
// Prompt 0167 — the zod schemas moved to schemas/welcomeSchemas.js, a
// module with zero database dependency — see that module's own header, and
// announcementSchemas.js's own header, for the full reasoning.
import { updateWelcomeSchema, copyToOtherBotSchema } from '../schemas/welcomeSchemas.js';

// Same memoryStorage + 10MB + JPG/PNG/WEBP-only shape as
// adminTelegramBroadcastRoutes.js's own imageUpload — this welcome image is
// ultimately sent via the same sendPhoto multipart path (see
// welcome.js's sendWelcomeMessage), so the same Telegram-driven size/type
// limits apply. GIF excluded for the same reason as broadcasts (animated
// GIFs need sendAnimation, not sendPhoto).
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return cb(new HttpError(400, 'UNSUPPORTED_FILE_TYPE', 'Only JPG, PNG, and WEBP images are supported.'));
    }
    cb(null, true);
  }
});

// Prompt 0137 — same memoryStorage + 50MB + MP4-only shape as
// adminTelegramBroadcastRoutes.js's own videoUpload; ultimately sent via
// the same sendVideo multipart path.
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'video/mp4') {
      return cb(new HttpError(400, 'UNSUPPORTED_FILE_TYPE', 'Only MP4 video is supported.'));
    }
    cb(null, true);
  }
});

function makeUploadErrorNormalizer(tooLargeMessage) {
  return function normalizeUploadError(err, req, res, next) {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new HttpError(400, 'FILE_TOO_LARGE', tooLargeMessage));
      }
      return next(new HttpError(400, 'UPLOAD_ERROR', err.message));
    }
    next(err);
  };
}
const normalizeImageUploadError = makeUploadErrorNormalizer('Image is too large — the limit is 10 MB.');
const normalizeVideoUploadError = makeUploadErrorNormalizer('Video is too large — the limit is 50 MB.');

export const adminWelcomeRoutes = Router();

adminWelcomeRoutes.use(requireAuth);

// Literal paths declared before the '/versions/:id/media' param route, same
// reasoning as adminTelegramBroadcastRoutes.js's own '/status' ordering
// note (not actually ambiguous here since none of these share a prefix,
// but kept adjacent to the routes they're conceptually paired with).
adminWelcomeRoutes.get('/', asyncHandler(controller.get));
adminWelcomeRoutes.put('/', validateBody(updateWelcomeSchema), asyncHandler(controller.update));
adminWelcomeRoutes.post('/copy-to-other-bot', validateBody(copyToOtherBotSchema), asyncHandler(controller.copyToOtherBot));
adminWelcomeRoutes.post('/image', imageUpload.single('image'), normalizeImageUploadError, asyncHandler(controller.uploadImage));
adminWelcomeRoutes.post('/video', videoUpload.single('video'), normalizeVideoUploadError, asyncHandler(controller.uploadVideo));
adminWelcomeRoutes.get('/media', asyncHandler(controller.getMedia));
adminWelcomeRoutes.get('/versions', asyncHandler(controller.listVersions));
adminWelcomeRoutes.get('/versions/:id/media', asyncHandler(controller.getVersionMedia));
