import { Router } from 'express';
import { check } from '../controllers/publicVersionController.js';

export const publicVersionRoutes = Router();

// Deliberately no auth and no request-logging middleware — same standing
// guarantee as publicAnnouncementsRoutes.js / publicEventsRoutes.js.
// Nothing about the caller's identity is read, stored, or logged anywhere
// in this path — this route doesn't even write to the database at all.
publicVersionRoutes.get('/', check);
