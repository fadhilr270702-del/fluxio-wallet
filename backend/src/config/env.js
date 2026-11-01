/**
 * Loads and validates environment configuration once at boot. Every other
 * module imports `config` from here instead of touching `process.env`
 * directly, so there's a single place that knows the full set of variables
 * this service depends on and what happens when one is missing.
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function int(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback) {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

const nodeEnv = process.env.NODE_ENV || 'development';

/**
 * Prompt 0191 — the structural Telegram kill switch. When TELEGRAM_DISABLED
 * is "1" or "true" (case-insensitive), resolveBotToken() below returns null
 * for EVERY bot regardless of what TELEGRAM_BOT_TOKEN_TEST/_OFFICIAL or the
 * legacy TELEGRAM_BOT_TOKEN contain — so no poller, worker, welcome send,
 * or admin-triggered send can ever run in this process, through the same
 * "null token = bot inactive" path every consumer already handles.
 *
 * Why it exists: twice (prompts 0181 and 0188), a backend spawned for local
 * verification loaded REAL trial-bot tokens from backend/.env because an
 * empty-string env override silently failed to reach the child process
 * (0188: PowerShell deletes a var set to "" on Windows — one real broadcast
 * round went out to real chats before the process was killed). "Is a token
 * present" proved too fragile as the only gate; this switch wins over any
 * token by construction. The production VM must NEVER set this variable —
 * it is a local-verification tool only (see .env.example).
 */
const telegramDisabled = /^(1|true)$/i.test(process.env.TELEGRAM_DISABLED || '');

/**
 * Prompt 0138 — resolves one bot's own token, with a one-time, one-bot-only
 * back-compat path: the OLD single-bot `TELEGRAM_BOT_TOKEN` var, if it's
 * still set and the new `TELEGRAM_BOT_TOKEN_<ID>` var for THIS bot isn't,
 * is treated as that bot's token (a deploy that hasn't migrated its .env
 * yet keeps working exactly as before, never crashes) — but only for the
 * bot the legacy var always meant, the trial bot ('test'); passing
 * `allowLegacyFallback: false` for every other bot id is what keeps the
 * old var from accidentally also activating a bot it was never meant for.
 * The warning is a plain console.warn at module-load time, so it fires
 * exactly once per process start, not once per call.
 */
function resolveBotToken(envSuffix, { allowLegacyFallback } = {}) {
  // Prompt 0191 — the kill switch wins over any token, and deliberately
  // returns before the legacy-var deprecation warning below: a disabled
  // process should print exactly one Telegram line (server.js's contract
  // line), not a warning about a token it will never use.
  if (telegramDisabled) return null;
  const specific = process.env[`TELEGRAM_BOT_TOKEN_${envSuffix}`];
  if (specific) return specific;
  if (allowLegacyFallback && process.env.TELEGRAM_BOT_TOKEN) {
    console.warn(
      `[config] TELEGRAM_BOT_TOKEN is deprecated as of prompt 0138 — set TELEGRAM_BOT_TOKEN_${envSuffix} instead. Using the legacy value for the '${envSuffix.toLowerCase()}' bot for now.`
    );
    return process.env.TELEGRAM_BOT_TOKEN;
  }
  return null;
}

/**
 * Same back-compat shape as resolveBotToken() above, for the storage chat
 * each bot's own broadcast-composer image/video upload would use to obtain
 * a file_id — not part of prompt 0138's own explicit schema list, but
 * needed for the same reason: a file_id is bot-scoped (see prompt 0135's
 * own investigation), so once a second bot token exists, its own uploads
 * need their own storage chat too, not the trial bot's. Deliberately
 * unused by anything yet in this Stage-A prompt — see
 * telegramBroadcastController.js's own comment on why broadcast media
 * upload itself stays hardcoded to the 'test' bot until Stage C's planned
 * media rework, but the config plumbing is added now rather than
 * threading a second env-var convention through later.
 */
function resolveStorageChatId(envSuffix, { allowLegacyFallback } = {}) {
  const specific = process.env[`TELEGRAM_STORAGE_CHAT_ID_${envSuffix}`];
  if (specific) return specific;
  if (allowLegacyFallback && process.env.TELEGRAM_STORAGE_CHAT_ID) {
    return process.env.TELEGRAM_STORAGE_CHAT_ID;
  }
  return null;
}

export const config = Object.freeze({
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: int(process.env.PORT, 4000),
  databasePath: path.resolve(backendRoot, process.env.DATABASE_PATH || './data/fluxio-admin.db'),
  adminOrigin: process.env.ADMIN_ORIGIN || 'http://localhost:4174',
  session: {
    cookieName: process.env.SESSION_COOKIE_NAME || 'fluxio_admin_session',
    ttlDays: int(process.env.SESSION_TTL_DAYS, 7),
    // Secure cookies require HTTPS — only forced on in production or if
    // explicitly opted into (e.g. testing behind an HTTPS tunnel).
    cookieSecure: nodeEnv === 'production' || bool(process.env.COOKIE_SECURE, false)
  },
  bcryptCost: int(process.env.BCRYPT_COST, 12),
  telegram: {
    // Prompt 0191 — see telegramDisabled's own comment above. Exposed on
    // config so server.js can print the one contract log line; everything
    // else is already gated by the null tokens this flag forces.
    disabled: telegramDisabled,
    // Prompt 0138 — per-bot token/storage-chat, keyed by the same bot id
    // strings botIds.js defines. A bot with `botToken: null` is simply
    // inactive: its poller/worker never start (logged once, not fatal),
    // and any admin action that would need it returns a clean error
    // instead of crashing — same "null = feature off" pattern this file
    // already used for the single bot token before this prompt.
    bots: {
      test: {
        botToken: resolveBotToken('TEST', { allowLegacyFallback: true }),
        storageChatId: resolveStorageChatId('TEST', { allowLegacyFallback: true })
      },
      official: {
        botToken: resolveBotToken('OFFICIAL', { allowLegacyFallback: false }),
        storageChatId: resolveStorageChatId('OFFICIAL', { allowLegacyFallback: false })
      }
    },
    // Worker/poller cadence stays global, shared across every active bot —
    // these are throttling knobs, not per-bot secrets, and there's no
    // requirement anywhere in this prompt for the two bots to run on
    // different schedules.
    pollTimeoutSeconds: int(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS, 25),
    workerBatchSize: int(process.env.TELEGRAM_WORKER_BATCH_SIZE, 20),
    workerTickMs: int(process.env.TELEGRAM_WORKER_TICK_MS, 1000),
    // Recurring-broadcast cadence (prompt 0134) — production always uses the
    // real 1-hour default; RECURRING_INTERVAL_MS exists purely so a
    // developer can verify the worker's own due-check end-to-end (e.g. a
    // 60000ms/1-minute override) without waiting a literal hour between
    // rounds. Same int()-with-fallback pattern as workerTickMs/
    // workerBatchSize above — never touch this for a real deployment.
    recurringIntervalMs: int(process.env.RECURRING_INTERVAL_MS, 60 * 60 * 1000),
    // Prompt 0166 — client.js's own API_ROOT used to be a hardcoded module
    // constant with no override at all; live-verifying "a transport error
    // fails the round outright, DB untouched" needed a way to point the
    // client at a dead address without touching a real bot. Gated on
    // `!isProduction` specifically so this can never silently activate in
    // a real deployment even if the var were accidentally left set in some
    // shared .env — it's read here, once, at boot, not sprinkled through
    // call sites. Never documented as a normal deploy knob (deliberately
    // absent from .env.example) since its only purpose is this one class
    // of local verification.
    apiRoot: nodeEnv !== 'production' && process.env.TELEGRAM_API_ROOT_TEST_ONLY ? process.env.TELEGRAM_API_ROOT_TEST_ONLY : 'https://api.telegram.org'
  }
});
