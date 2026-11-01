import { Router } from 'express';
import { listPublic } from '../controllers/publicAnnouncementsController.js';

export const publicAnnouncementsRoutes = Router();

// Deliberately no auth middleware and no request-logging middleware (see
// app.js — the request logger, if any is ever added, must not be applied
// here) mounted on this router. This is the wallet-facing public read.
publicAnnouncementsRoutes.get('/', listPublic);
