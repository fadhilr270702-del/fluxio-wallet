/**
 * Aggregate-only analytics for the admin dashboard — every value here is a
 * count or a breakdown, never an individual wallet_id or event row. See
 * db/repositories/analyticsEventsRepo.js for the query layer.
 */
import {
  countTotalWalletCreated,
  dailyWalletCreatedCounts,
  platformBreakdown,
  chainBreakdown
} from '../db/repositories/analyticsEventsRepo.js';
import {
  countActiveSubscribersBySource,
  countActiveSubscribers,
  countNewSubscribersSince,
  countNewSubscribersBetween,
  countSubscribersFromAds,
  countUnsubscribedSince,
  dailyNewSubscribers
} from '../db/repositories/telegramSubscribersRepo.js';
import { BOT_IDS } from '../telegram/botIds.js';

// Prompt 0235 — the one bot whose subscriber metrics the admin cards
// summarize (the trial bot only ever appears in the per-bot series and the
// by-source rows).
const OFFICIAL_BOT_ID = 'official';

const DEFAULT_DAYS = 30;
const MIN_DAYS = 1;
const MAX_DAYS = 90;

function clampDays(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, parsed));
}

/** Builds a zero-filled ascending array of the last `days` UTC calendar days, ending today. */
function buildDayWindow(days) {
  const result = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    result.push(d.toISOString().slice(0, 10));
  }
  return result;
}

export function summary(req, res) {
  const days = clampDays(req.query.days);
  const since = buildDayWindow(days)[0];
  const sinceIso = `${since}T00:00:00.000Z`;

  const countsByDay = new Map(dailyWalletCreatedCounts({ sinceIso }).map((row) => [row.day, row.count]));
  const dailyTrend = buildDayWindow(days).map((date) => ({ date, count: countsByDay.get(date) ?? 0 }));

  // Prompt 0233 — Telegram subscribers grouped by acquisition source
  // (/start deep-link payload; null = organic), per bot. Aggregate counts
  // only, never a chat id — same stance as every other field here.
  const telegramSubscribersBySource = BOT_IDS.flatMap((botId) =>
    countActiveSubscribersBySource(botId).map((row) => ({ botId, source: row.source, count: row.count }))
  );

  // Prompt 0235 — live Telegram subscriber metrics for the admin cards
  // (the wallet fields above stay for compatibility; the analytics_events
  // table has never received a beacon and the extension sends no new
  // signals, an explicit owner decision). Day boundaries are UTC — the
  // frontend labels say so. 7-day windows are rolling 7 x 24 hours.
  const nowMs = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const todayStartIso = `${buildDayWindow(1)[0]}T00:00:00.000Z`;
  const window30 = buildDayWindow(30);
  const since30Iso = `${window30[0]}T00:00:00.000Z`;
  const dailyNewByBot = Object.fromEntries(
    BOT_IDS.map((botId) => {
      const byDay = new Map(dailyNewSubscribers(botId, since30Iso).map((row) => [row.day, row.count]));
      return [botId, window30.map((date) => ({ date, count: byDay.get(date) ?? 0 }))];
    })
  );

  res.json({
    totalWalletsCreated: countTotalWalletCreated(),
    days,
    dailyTrend,
    platformBreakdown: platformBreakdown(),
    chainBreakdown: chainBreakdown(),
    telegramSubscribersBySource,
    activeSubscribers: countActiveSubscribers(OFFICIAL_BOT_ID),
    newSubscribers7d: countNewSubscribersSince(OFFICIAL_BOT_ID, iso(nowMs - 7 * 86400000)),
    newSubscribersPrev7d: countNewSubscribersBetween(OFFICIAL_BOT_ID, iso(nowMs - 14 * 86400000), iso(nowMs - 7 * 86400000)),
    newSubscribersToday: countNewSubscribersSince(OFFICIAL_BOT_ID, todayStartIso),
    subscribersFromAds: countSubscribersFromAds(OFFICIAL_BOT_ID),
    unsubscribed30d: countUnsubscribedSince(OFFICIAL_BOT_ID, iso(nowMs - 30 * 86400000)),
    dailyNewSubscribers: dailyNewByBot
  });
}
