/**
 * Prompt 0246 — editing an active recurring broadcast's SCHEDULE from the
 * same PATCH /:id/content the Edit page already uses: intervalHours +
 * nextRunAt (optional, always a pair). The new anchor is the chosen next
 * round; rounds then fall on anchor + k × interval.
 *
 * Covers the handler through the REAL endpoint (validation, atomic content
 * + schedule write, the audit trail with old and new schedule) and the
 * worker for the three moments a change can land: while idle, while a
 * round is running (it finishes untouched), and while a round is running
 * that then finishes AFTER the chosen time (owner decision: that scheduled
 * round is not skipped, it runs right after the round in progress).
 *
 * Same harness as recurringRoundsFix0234.test.js — temp DB, dummy trial
 * bot token, Telegram fetch stubbed in process — except the admin session
 * comes from a NORMAL login through POST /admin/login (the 0235 rule: no
 * hand-written session rows).
 *
 * "Time passing" is emulated by shifting the broadcast's own stored
 * timestamps (anchor, last send, round start/finish) back by the same
 * amount — equivalent to the clock advancing, with no fake timers near the
 * worker's real rate limiter.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOUR = 60 * 60 * 1000;
const TEST_TIMEOUT_MS = 30000;

let getDb;
let tempDir;
let worker;
let repo;
let roundsRepo;
let subscribersRepo;
let sessionCookie;
let adminId;
let server;
let baseUrl;
let realFetch;

const sends = []; // chat ids, in send order
const plan = { delayMs: 0, onFirstSend: null };
let firstSendSignalled = false;

function installFetchStub() {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')) {
      return realFetch(url, options);
    }
    const reply = (result) => ({ json: async () => ({ ok: true, result }) });
    if (u.endsWith('/getUpdates')) return reply([]);
    if (u.endsWith('/sendMessage')) {
      const body = JSON.parse(options.body);
      if (!firstSendSignalled && plan.onFirstSend) {
        firstSendSignalled = true;
        await plan.onFirstSend();
      }
      if (plan.delayMs > 0) await new Promise((r) => setTimeout(r, plan.delayMs));
      sends.push(String(body.chat_id));
      return reply({ message_id: 9000 + sends.length });
    }
    throw new Error(`fetch tak terduga di recurringReschedule0246: ${u}`);
  };
}

function resetPlan() {
  sends.length = 0;
  plan.delayMs = 0;
  plan.onFirstSend = null;
  firstSendSignalled = false;
}

function seedSubscribers(n, prefix) {
  getDb().prepare('UPDATE telegram_subscribers SET is_active = 0').run();
  for (let i = 0; i < n; i += 1) {
    subscribersRepo.upsertFromStart({ botId: 'test', chatId: `${prefix}${String(i).padStart(3, '0')}`, firstName: 'x' });
  }
}

/** An active recurring broadcast, every 6 hours, anchored one hour ago (so its first round is due now). */
function makeRecurring(overrides = {}) {
  return repo.createBroadcast({
    botId: 'test',
    title: 'reschedule 0246',
    body: 'original body',
    targetType: 'subscribers',
    totalCount: 0,
    createdBy: adminId,
    recurring: true,
    recurringIntervalHours: 6,
    recurringStartsAt: new Date(Date.now() - HOUR).toISOString(),
    ...overrides
  });
}

function patchContent(id, body) {
  return realFetch(`${baseUrl}/admin/broadcast/telegram/${id}/content`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify(body)
  });
}

async function getApiBroadcast(id) {
  const res = await realFetch(`${baseUrl}/admin/broadcast/telegram/${id}`, { headers: { cookie: sessionCookie } });
  expect(res.status).toBe(200);
  return (await res.json()).broadcast;
}

function auditRows(id) {
  return getDb()
    .prepare('SELECT admin_id, action, metadata FROM audit_logs WHERE target_id = ? ORDER BY created_at, rowid')
    .all(id)
    .map((row) => ({ adminId: row.admin_id, action: row.action, metadata: JSON.parse(row.metadata) }));
}

/** Emulates `ms` of wall clock passing for this broadcast: every stored timestamp the scheduler reads moves back by `ms`. */
function letTimePass(id, ms) {
  const db = getDb();
  const shift = (iso) => (iso ? new Date(Date.parse(iso) - ms).toISOString() : null);
  const row = repo.findBroadcastById(id);
  db.prepare('UPDATE telegram_broadcasts SET recurring_starts_at = ?, recurring_last_sent_at = ? WHERE id = ?').run(
    shift(row.recurring_starts_at),
    shift(row.recurring_last_sent_at),
    id
  );
  for (const round of db.prepare('SELECT id, started_at, finished_at FROM telegram_recurring_rounds WHERE broadcast_id = ?').all(id)) {
    db.prepare('UPDATE telegram_recurring_rounds SET started_at = ?, finished_at = ? WHERE id = ?').run(
      shift(round.started_at),
      shift(round.finished_at),
      round.id
    );
  }
}

const EDITED = { title: 'edited title', body: 'edited body' };

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'fluxio-reschedule-0246-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
  process.env.TELEGRAM_BOT_TOKEN_TEST = '123456:reschedule-0246-dummy';
  process.env.BCRYPT_COST = '4';
  delete process.env.TELEGRAM_DISABLED;
  installFetchStub();

  const { runMigrations } = await import('../../db/migrate.js');
  runMigrations();
  ({ getDb } = await import('../../db/client.js'));
  worker = await import('../worker.js');
  repo = await import('../../db/repositories/telegramBroadcastsRepo.js');
  roundsRepo = await import('../../db/repositories/telegramRecurringRoundsRepo.js');
  subscribersRepo = await import('../../db/repositories/telegramSubscribersRepo.js');

  const { createAdmin } = await import('../../db/repositories/adminsRepo.js');
  const { hashPassword } = await import('../../utils/password.js');
  const password = 'reschedule-0246-password';
  const admin = createAdmin({ email: 'reschedule-0246@example.com', passwordHash: await hashPassword(password) });
  adminId = admin.id;

  const { createApp } = await import('../../app.js');
  server = createApp().listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // A normal login: the cookie the browser would hold.
  const login = await realFetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'reschedule-0246@example.com', password })
  });
  expect(login.status).toBe(200);
  sessionCookie = login.headers.getSetCookie()[0].split(';')[0];
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  globalThis.fetch = realFetch;
  delete process.env.TELEGRAM_BOT_TOKEN_TEST;
  delete process.env.BCRYPT_COST;
  if (getDb) getDb().close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('PATCH /:id/content — recurring schedule (0246)', () => {
  it('saves content and schedule in one request: the anchor becomes the chosen next round, the interval the new one, and the audit log records old and new', async () => {
    resetPlan();
    const b = makeRecurring();
    const before = await getApiBroadcast(b.id);
    const nextRunAt = new Date(Date.now() + 90 * 60 * 1000).toISOString();

    const res = await patchContent(b.id, { ...EDITED, intervalHours: 48, nextRunAt });
    expect(res.status).toBe(200);
    const updated = (await res.json()).broadcast;
    expect(updated.title).toBe('edited title');
    expect(updated.body).toBe('edited body');
    expect(updated.status).toBe('recurring');
    expect(updated.recurringIntervalHours).toBe(48);
    expect(updated.recurringStartsAt).toBe(nextRunAt);
    expect(updated.recurringNextRoundAt).toBe(nextRunAt); // History, cards and Dashboard read this field

    const row = repo.findBroadcastById(b.id);
    expect(row.recurring_interval_hours).toBe(48);
    expect(row.recurring_starts_at).toBe(nextRunAt);

    const audit = auditRows(b.id);
    expect(audit.map((a) => a.action)).toEqual(['broadcast.telegram.update', 'broadcast.telegram.recurring_reschedule']);
    const reschedule = audit[1];
    expect(reschedule.adminId).toBe(adminId);
    expect(reschedule.metadata).toEqual({
      bot: 'test',
      title: 'edited title',
      from: { intervalHours: 6, nextRoundAt: before.recurringNextRoundAt },
      to: { intervalHours: 48, nextRoundAt: nextRunAt }
    });
    repo.transitionFromRecurring(b.id, 'completed');
  });

  it('a content only edit leaves the schedule exactly as it was and records no reschedule', async () => {
    resetPlan();
    const b = makeRecurring();
    const res = await patchContent(b.id, EDITED);
    expect(res.status).toBe(200);
    const row = repo.findBroadcastById(b.id);
    expect(row.title).toBe('edited title');
    expect(row.recurring_interval_hours).toBe(6);
    expect(row.recurring_starts_at).toBe(b.recurring_starts_at);
    expect(auditRows(b.id).map((a) => a.action)).toEqual(['broadcast.telegram.update']);
    repo.transitionFromRecurring(b.id, 'completed');
  });

  it('rejects a next round in the past, a bad interval, and half a pair with a clear message, changing nothing at all', async () => {
    resetPlan();
    const b = makeRecurring();
    const future = new Date(Date.now() + HOUR).toISOString();
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const cases = [
      [{ ...EDITED, intervalHours: 6, nextRunAt: past }, 'nextRunAt: The next round must be in the future.'],
      [{ ...EDITED, intervalHours: 0, nextRunAt: future }, 'intervalHours:'],
      [{ ...EDITED, intervalHours: 169, nextRunAt: future }, 'intervalHours:'],
      [{ ...EDITED, intervalHours: 1.5, nextRunAt: future }, 'intervalHours:'],
      [{ ...EDITED, intervalHours: 6 }, 'nextRunAt:'],
      [{ ...EDITED, nextRunAt: future }, 'intervalHours:']
    ];
    for (const [body, expectedFragment] of cases) {
      const res = await patchContent(b.id, body);
      expect(res.status).toBe(400);
      const error = (await res.json()).error;
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toContain(expectedFragment);
    }
    const row = repo.findBroadcastById(b.id);
    expect(row.title).toBe('reschedule 0246'); // not even the content half was written
    expect(row.recurring_interval_hours).toBe(6);
    expect(row.recurring_starts_at).toBe(b.recurring_starts_at);
    expect(auditRows(b.id)).toEqual([]);
    repo.transitionFromRecurring(b.id, 'completed');
  });

  it('schedule fields on a one time scheduled broadcast are refused (409 NOT_RECURRING) and the content is NOT written either', async () => {
    resetPlan();
    const scheduled = repo.createBroadcast({
      botId: 'test',
      title: 'one time',
      body: 'one time body',
      targetType: 'subscribers',
      totalCount: 0,
      createdBy: adminId,
      scheduledAt: new Date(Date.now() + 24 * HOUR).toISOString()
    });
    const res = await patchContent(scheduled.id, { ...EDITED, intervalHours: 6, nextRunAt: new Date(Date.now() + HOUR).toISOString() });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('NOT_RECURRING');
    const row = repo.findBroadcastById(scheduled.id);
    expect(row.title).toBe('one time');
    expect(row.recurring_interval_hours).toBe(1);
    expect(row.recurring_starts_at).toBe(null);
    expect(auditRows(scheduled.id)).toEqual([]);
    repo.transitionFromScheduled(scheduled.id, 'canceled');
  });
});

describe('worker — schedule changed while idle (0246)', () => {
  it('no round before the chosen time, exactly one round at it, then one per interval from the new anchor', async () => {
    resetPlan();
    seedSubscribers(3, 'idle');
    const b = makeRecurring();
    await worker.processDueRecurring(); // round 1 on the OLD schedule
    expect(sends).toHaveLength(3);

    const nextRunAt = new Date(Date.now() + 2 * HOUR).toISOString();
    expect((await patchContent(b.id, { ...EDITED, intervalHours: 1, nextRunAt })).status).toBe(200);

    resetPlan();
    await worker.processDueRecurring();
    expect(sends).toHaveLength(0);

    // 61 minutes later: still 59 minutes before the chosen time. The
    // pre-0246 arithmetic fired here (a slot one interval BEFORE the anchor).
    letTimePass(b.id, 61 * 60 * 1000);
    await worker.processDueRecurring();
    expect(sends).toHaveLength(0);
    expect((await getApiBroadcast(b.id)).recurringNextRoundAt).toBe(repo.findBroadcastById(b.id).recurring_starts_at);

    // Past the chosen time: one round, not two.
    letTimePass(b.id, 60 * 60 * 1000);
    await worker.processDueRecurring();
    expect(sends).toHaveLength(3);
    await worker.processDueRecurring();
    await worker.processDueRecurring();
    expect(sends).toHaveLength(3);
    expect(repo.findBroadcastById(b.id).sent_count).toBe(2);

    // The round after that is one NEW interval after the new anchor.
    const api = await getApiBroadcast(b.id);
    expect(Date.parse(api.recurringNextRoundAt) - Date.parse(api.recurringStartsAt)).toBe(HOUR);
    repo.transitionFromRecurring(b.id, 'completed');
  }, TEST_TIMEOUT_MS);

  it('an interrupted round that delivered nothing (open, no cursor) waits for the new anchor instead of a slot before it', async () => {
    resetPlan();
    seedSubscribers(3, 'open');
    const b = makeRecurring();
    roundsRepo.createRound(b.id, new Date(Date.now() - 3 * HOUR).toISOString());
    const nextRunAt = new Date(Date.now() + HOUR).toISOString();
    expect((await patchContent(b.id, { ...EDITED, intervalHours: 1, nextRunAt })).status).toBe(200);

    await worker.processDueRecurring();
    expect(sends).toHaveLength(0);

    letTimePass(b.id, HOUR + 1000);
    await worker.processDueRecurring();
    expect(sends).toHaveLength(3);
    await worker.processDueRecurring();
    expect(sends).toHaveLength(3);
    repo.transitionFromRecurring(b.id, 'completed');
  }, TEST_TIMEOUT_MS);
});

describe('worker — schedule changed while a round is running (0246)', () => {
  it('the round in progress finishes untouched (every subscriber exactly once), and the new schedule applies from the next round', async () => {
    resetPlan();
    seedSubscribers(30, 'run');
    plan.delayMs = 20;
    const b = makeRecurring();
    let nextRunAt;
    plan.onFirstSend = async () => {
      nextRunAt = new Date(Date.now() + HOUR).toISOString();
      const res = await patchContent(b.id, { ...EDITED, intervalHours: 2, nextRunAt });
      expect(res.status).toBe(200);
    };
    await worker.processDueRecurring();
    expect(sends).toHaveLength(30);
    expect(new Set(sends).size).toBe(30); // not cut short, nobody twice

    const row = repo.findBroadcastById(b.id);
    expect(row.status).toBe('recurring');
    expect(row.sent_count).toBe(1); // the running round was recorded normally
    expect(row.recurring_interval_hours).toBe(2);
    expect(row.recurring_starts_at).toBe(nextRunAt);
    expect((await getApiBroadcast(b.id)).recurringNextRoundAt).toBe(nextRunAt);

    resetPlan();
    await worker.processDueRecurring();
    expect(sends).toHaveLength(0); // nothing until the chosen time

    letTimePass(b.id, HOUR + 1000);
    await worker.processDueRecurring();
    expect(sends).toHaveLength(30);
    expect(new Set(sends).size).toBe(30);
    await worker.processDueRecurring();
    expect(sends).toHaveLength(30); // one round for that slot, not two

    const api = await getApiBroadcast(b.id);
    expect(Date.parse(api.recurringNextRoundAt) - Date.parse(api.recurringStartsAt)).toBe(2 * HOUR);
    repo.transitionFromRecurring(b.id, 'completed');
  }, TEST_TIMEOUT_MS);

  it('a round in progress that finishes AFTER the chosen time does not swallow it: the scheduled round runs right after, exactly once', async () => {
    resetPlan();
    seedSubscribers(30, 'over');
    plan.delayMs = 40; // 30 sends at 25 per second: the round outlives the 500 ms below
    const b = makeRecurring();
    let nextRunAt;
    plan.onFirstSend = async () => {
      nextRunAt = new Date(Date.now() + 500).toISOString(); // in the future when validated
      const res = await patchContent(b.id, { ...EDITED, intervalHours: 3, nextRunAt });
      expect(res.status).toBe(200);
    };
    await worker.processDueRecurring();
    expect(sends).toHaveLength(30);

    const row = repo.findBroadcastById(b.id);
    expect(row.recurring_starts_at).toBe(nextRunAt);
    // The real overrun: the round started before the chosen time and its
    // recorded finish is after it.
    expect(Date.parse(row.recurring_last_sent_at)).toBeGreaterThan(Date.parse(nextRunAt));
    expect(Date.parse(roundsRepo.findLastFinishedRound(b.id).started_at)).toBeLessThan(Date.parse(nextRunAt));
    expect((await getApiBroadcast(b.id)).recurringNextRoundAt).toBe(nextRunAt); // still owed, and shown as such

    resetPlan();
    await worker.processDueRecurring(); // the scheduled round, right after the one in progress
    expect(sends).toHaveLength(30);
    expect(new Set(sends).size).toBe(30);
    await worker.processDueRecurring();
    await worker.processDueRecurring();
    expect(sends).toHaveLength(30); // owed once, sent once
    expect(repo.findBroadcastById(b.id).sent_count).toBe(2);

    expect((await getApiBroadcast(b.id)).recurringNextRoundAt).toBe(new Date(Date.parse(nextRunAt) + 3 * HOUR).toISOString());
    repo.transitionFromRecurring(b.id, 'completed');
  }, TEST_TIMEOUT_MS);
});
