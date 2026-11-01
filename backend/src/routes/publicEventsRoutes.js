import { Router } from 'express';
import { z } from 'zod';
import { NETWORK_KEYS } from '@fluxio/constants';
import { create } from '../controllers/publicEventsController.js';
import { validateBody } from '../middleware/validate.js';

// Same refine pattern as adminAnnouncementsRoutes.js's isoDateString —
// duplicated locally rather than shared, it's 4 lines.
const isoDateString = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Must be a valid ISO-8601 date string.' });

const CHAIN_KEYS = Object.values(NETWORK_KEYS);

// Only WALLET_CREATED is accepted for now — this is a narrower gate than
// the analytics_events table itself, which deliberately leaves `event`
// unconstrained at the DB layer for future event types (see the migration).
const createEventSchema = z.object({
  event: z.enum(['WALLET_CREATED']),
  walletId: z.string().trim().min(1).max(128),
  platform: z.enum(['web', 'extension', 'mobile']),
  timestamp: isoDateString,
  chains: z
    .array(z.enum(CHAIN_KEYS))
    .min(1)
    .max(CHAIN_KEYS.length)
    .transform((arr) => Array.from(new Set(arr)))
});

export const publicEventsRoutes = Router();

// Deliberately no auth and no request-logging middleware — same standing
// guarantee as publicAnnouncementsRoutes.js. Nothing about the caller's
// identity is read, stored, or logged anywhere in this path.
publicEventsRoutes.post('/', validateBody(createEventSchema), create);
