import { Router } from 'express';
import * as controller from '../controllers/adminAnnouncementsController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
// Prompt 0167 — the zod schemas (createSchema/updateSchema) moved to
// schemas/announcementSchemas.js, a module with zero database dependency,
// specifically so a test that only needs schema.safeParse() never has to
// import this route file (and therefore never transitively pulls in
// controller -> repo -> db/client.js, which used to open a real connection
// to the actual dev database as a pure import side effect). See that
// module's own header, and prompt/0167's archive, for the full incident.
import { createSchema, updateSchema } from '../schemas/announcementSchemas.js';

export const adminAnnouncementsRoutes = Router();

// Every route in this router requires an authenticated admin session —
// mounted once here rather than repeated per-handler (see requireAuth.js).
adminAnnouncementsRoutes.use(requireAuth);

adminAnnouncementsRoutes.get('/', controller.list);
adminAnnouncementsRoutes.post('/', validateBody(createSchema), asyncHandler(controller.create));
adminAnnouncementsRoutes.get('/:id', controller.get);
adminAnnouncementsRoutes.put('/:id', validateBody(updateSchema), asyncHandler(controller.update));
adminAnnouncementsRoutes.post('/:id/publish', controller.publish);
adminAnnouncementsRoutes.post('/:id/unpublish', controller.unpublish);
adminAnnouncementsRoutes.delete('/:id', controller.remove);
