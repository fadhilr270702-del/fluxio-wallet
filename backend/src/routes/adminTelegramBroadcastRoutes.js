import { Router } from 'express';
import multer from 'multer';
import * as controller from '../controllers/telegramBroadcastController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { HttpError } from '../utils/httpError.js';
// Prompt 0167 — the zod schemas moved to schemas/telegramBroadcastSchemas.js,
// a module with zero database dependency — see that module's own header,
// and announcementSchemas.js's own header, for the full reasoning.
import { createBroadcastSchema, updateContentSchema, rescheduleSchema } from '../schemas/telegramBroadcastSchemas.js';

// memoryStorage — the uploaded file only ever exists as an in-memory
// Buffer for the life of this one request (see controller.uploadImage/
// uploadVideo), never written to disk. Two separate multer instances,
// deliberately not shared: image is capped at 10MB (Telegram's own
// multipart-upload cap for photos), video at 50MB (Telegram's own cap for
// videos) — reusing one instance for both would wrongly cap video at
// image's smaller limit. gif is deliberately excluded from images
// (animated GIFs need sendAnimation, and static-vs-animated isn't reliably
// distinguishable from mimetype alone — a scoping choice, not an oversight).
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

// Factory, not a single shared middleware — image and video need different
// "too large" wording (different limits). Placed right after
// upload.single() so a multer-specific failure (e.g. LIMIT_FILE_SIZE) is
// normalized into this app's own {error:{code,message}} shape instead of a
// raw multer message. Anything that isn't a MulterError (e.g. the
// HttpError a fileFilter above throws) just passes through unchanged to
// the app-level errorHandler, which already handles HttpError.
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

export const adminTelegramBroadcastRoutes = Router();

// Every route in this router requires an authenticated admin session —
// mounted once here rather than repeated per-handler (see requireAuth.js).
adminTelegramBroadcastRoutes.use(requireAuth);

// Declared before '/:id' so a literal '/status' request isn't swallowed by
// the param route.
adminTelegramBroadcastRoutes.get('/status', asyncHandler(controller.status));
adminTelegramBroadcastRoutes.get('/', controller.list);
adminTelegramBroadcastRoutes.post('/', validateBody(createBroadcastSchema), asyncHandler(controller.create));
// Literal paths, declared before '/:id' for the same reason '/status' is.
adminTelegramBroadcastRoutes.post('/upload-image', imageUpload.single('image'), normalizeImageUploadError, asyncHandler(controller.uploadImage));
adminTelegramBroadcastRoutes.post('/upload-video', videoUpload.single('video'), normalizeVideoUploadError, asyncHandler(controller.uploadVideo));
adminTelegramBroadcastRoutes.get('/:id', controller.get);
adminTelegramBroadcastRoutes.get('/:id/media', asyncHandler(controller.getMedia));
adminTelegramBroadcastRoutes.post('/:id/cancel', asyncHandler(controller.cancel));
adminTelegramBroadcastRoutes.post('/:id/deactivate-recurring', asyncHandler(controller.deactivateRecurring));
adminTelegramBroadcastRoutes.patch('/:id/content', validateBody(updateContentSchema), asyncHandler(controller.updateContent));
adminTelegramBroadcastRoutes.patch('/:id/schedule', validateBody(rescheduleSchema), asyncHandler(controller.reschedule));
