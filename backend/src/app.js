/**
 * Express app assembly. server.js is the only thing that calls listen() —
 * keeping app construction separate makes this importable from tests later
 * without binding a real port.
 */
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config/env.js';
import { authRoutes } from './routes/authRoutes.js';
import { adminAnnouncementsRoutes } from './routes/adminAnnouncementsRoutes.js';
import { publicAnnouncementsRoutes } from './routes/publicAnnouncementsRoutes.js';
import { adminTelegramBroadcastRoutes } from './routes/adminTelegramBroadcastRoutes.js';
import { adminWelcomeRoutes } from './routes/adminWelcomeRoutes.js';
import { adminAnalyticsRoutes } from './routes/adminAnalyticsRoutes.js';
import { publicEventsRoutes } from './routes/publicEventsRoutes.js';
import { adminVersionsRoutes } from './routes/adminVersionsRoutes.js';
import { publicVersionRoutes } from './routes/publicVersionRoutes.js';
import { adminAdminsRoutes } from './routes/adminAdminsRoutes.js';
import { adminAuditLogsRoutes } from './routes/adminAuditLogsRoutes.js';
import { adminEmojiPacksRoutes } from './routes/adminEmojiPacksRoutes.js';
import { adminEmojiAssetsRoutes } from './routes/adminEmojiAssetsRoutes.js';
import { errorHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();

  // Prompt 0178 — a real deploy (behind Caddy on api.fluxiowallet.com)
  // surfaced this in a live response header: Express's default
  // `X-Powered-By: Express` was reaching the public internet, telling any
  // observer the exact framework running behind the proxy for free. This
  // is the one and only line needed to turn it off — Express ships a
  // dedicated method for it rather than requiring a manual header strip.
  app.disable('x-powered-by');

  // Two separate CORS policies, path-scoped: /admin/* carries the session
  // cookie, so it stays locked to config.adminOrigin with credentials on.
  // /api/* (announcements, events) is unauthenticated and cookie-less by
  // design — wallet apps call it from their own origins (apps/web,
  // chrome-extension://...), none of which are config.adminOrigin, so it
  // gets an open-origin policy instead. Open CORS here doesn't change these
  // routes' security surface — there's no credential to protect.
  app.use('/admin', cors({ origin: config.adminOrigin, credentials: true }));
  app.use('/api', cors());
  app.use(cookieParser());
  app.use(express.json());

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.use('/admin', authRoutes);
  app.use('/admin/announcements', adminAnnouncementsRoutes);
  app.use('/admin/broadcast/telegram', adminTelegramBroadcastRoutes);
  app.use('/admin/welcome', adminWelcomeRoutes);
  app.use('/admin/analytics', adminAnalyticsRoutes);
  app.use('/admin/versions', adminVersionsRoutes);
  app.use('/admin/admins', adminAdminsRoutes);
  app.use('/admin/audit-logs', adminAuditLogsRoutes);
  // NOT nested under /admin/broadcast/telegram — that router (mounted just
  // above) already owns a catch-all `/:id` route at that exact prefix, so
  // `/admin/broadcast/telegram/emoji-packs` would be swallowed as a
  // broadcast-id lookup (id="emoji-packs") before ever reaching this
  // router. A separate top-level path sidesteps the collision entirely,
  // matching how /admin/welcome, /admin/versions, etc. are already their
  // own top-level admin resources rather than nested under broadcast/telegram.
  app.use('/admin/emoji-packs', adminEmojiPacksRoutes);
  app.use('/admin/emoji-assets', adminEmojiAssetsRoutes);
  // No auth, no logging — see publicAnnouncementsRoutes.js / publicEventsRoutes.js / publicVersionRoutes.js.
  app.use('/api/announcements', publicAnnouncementsRoutes);
  app.use('/api/events', publicEventsRoutes);
  app.use('/api/version', publicVersionRoutes);

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such route.' } });
  });

  // Registered last, and after every route — Express only recognizes an
  // error handler by its 4-argument signature.
  app.use(errorHandler);

  return app;
}
