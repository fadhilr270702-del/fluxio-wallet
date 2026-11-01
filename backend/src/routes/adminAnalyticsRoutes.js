import { Router } from 'express';
import * as controller from '../controllers/adminAnalyticsController.js';
import { requireAuth } from '../middleware/requireAuth.js';

export const adminAnalyticsRoutes = Router();

// Every route in this router requires an authenticated admin session —
// mounted once here rather than repeated per-handler (see requireAuth.js).
adminAnalyticsRoutes.use(requireAuth);

adminAnalyticsRoutes.get('/summary', controller.summary);
