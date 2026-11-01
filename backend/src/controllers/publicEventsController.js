/**
 * The second unauthenticated, public-facing endpoint in this service (see
 * publicAnnouncementsController.js for the first). Wallet apps beacon
 * lifecycle events here. Nothing about the caller's identity (no IP, no
 * user-agent) is read, stored, or logged anywhere in this path — see
 * routes/publicEventsRoutes.js for the standing "no logging middleware on
 * this route" guarantee. `walletId` is a random client-generated ID, never
 * an on-chain address or public key, and this response never reveals
 * whether the event was new or a deduped retry — that's an internal detail.
 */
import { insertWalletCreatedEvent } from '../db/repositories/analyticsEventsRepo.js';

export function create(req, res) {
  const { walletId, platform, timestamp, chains } = req.body;
  insertWalletCreatedEvent({ walletId, platform, timestamp, chains });
  res.status(202).json({ ok: true });
}
