/**
 * Prompt 0234 fase 2 — the P1/P3/P5 behaviors that need load/cursor cases
 * beyond recurringBehavior0234.test.js's three-subscriber scenarios:
 * the zombie stop bound (120 subscribers), atomic replace through the REAL
 * endpoint, resume-after-restart from a crafted cursor, the identical
 * started_at tie break, the P5 throttle, and the P4 fields on the real
 * list endpoint. Same harness as 0233: temp DB, dummy trial-bot token,
 * global fetch stubbed (localhost requests pass through to the real fetch
 * for the endpoint tests; Telegram requests never leave the process).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let getDb;
let tempDir;
let worker;
let repo;
let roundsRepo;
let subscribersRepo;
let createApp;
let config;
let sessionCookie;
let adminId;
let server;
let baseUrl;

const sends = []; // { chatId, at }
const plan = { delayMs: 0, onFirstSend: null };
let firstSendSignalled = false;
let inFlightNow = 0;
let maxInFlight = 0;
let realFetch;

function installFetchStub() {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')) {
      return realFetch(url, options); // the endpoint tests' own app server
    }
    const reply = (result) => ({ json: async () => ({ ok: true, result }) });
    if (u.endsWith('/getUpdates')) return reply([]);
    if (u.endsWith('/sendMessage')) {
      const body = JSON.parse(options.body);
      if (!firstSendSignalled && plan.onFirstSend) {
        firstSendSignalled = true;
        plan.onFirstSend();
      }
      inFlightNow += 1;
      maxInFlight = Math.max(maxInFlight, inFlightNow);
      if (plan.delayMs > 0) await new Promise((r) => setTimeout(r, plan.delayMs));
      inFlightNow -= 1;
      sends.push({ chatId: body.chat_id, at: Date.now() });
      return reply({ message_id: 7000 + sends.length });
    }
    throw new Error(`fetch tak terduga di recurringRoundsFix0234: ${u}`);
  };
}

function resetPlan() {
  sends.length = 0;
  plan.delayMs = 0;
  plan.onFirstSend = null;
  firstSendSignalled = false;
  inFlightNow = 0;
  maxInFlight = 0;
}

/** Deactivates every subscriber, then seeds `n` fresh active ones for bot 'test'. */
function seedSubscribers(n, prefix) {
  getDb().prepare('UPDATE telegram_subscribers SET is_active = 0').run();
  for (let i = 0; i < n; i += 1) {
    subscribersRepo.upsertFromStart({ botId: 'test', chatId: `${prefix}${String(i).padStart(3, '0')}`, firstName: 'x' });
  }
  return subscribersRepo.listActiveSubscribers('test');
}

function makeRecurring() {
  return repo.createBroadcast({
    botId: 'test',
    title: 'fix 0234',
    body: 'body',
    targetType: 'subscribers',
    totalCount: 0,
    createdBy: adminId,
    recurring: true,
    recurringIntervalHours: 6,
    recurringStartsAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
  });
}

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'fluxio-rounds-fix-0234-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
  process.env.TELEGRAM_BOT_TOKEN_TEST = '123456:rounds-fix-dummy';
  delete process.env.TELEGRAM_DISABLED;
  installFetchStub();

  const { runMigrations } = await import('../../db/migrate.js');
  runMigrations();
  ({ getDb } = await import('../../db/client.js'));
  worker = await import('../worker.js');
  repo = await import('../../db/repositories/telegramBroadcastsRepo.js');
  roundsRepo = await import('../../db/repositories/telegramRecurringRoundsRepo.js');
  subscribersRepo = await import('../../db/repositories/telegramSubscribersRepo.js');
  ({ config } = await import('../../config/env.js'));

  // A real admin + session for the endpoint tests (adminAnalyticsSummary's
  // own pattern) — also the created_by FK every broadcast row needs.
  const { createAdmin } = await import('../../db/repositories/adminsRepo.js');
  const { createSession } = await import('../../db/repositories/sessionsRepo.js');
  const { generateSessionToken, hashSessionToken } = await import('../../utils/sessionToken.js');
  const admin = createAdmin({ email: 'rounds-fix-0234@example.com', passwordHash: 'unused-placeholder' });
  adminId = admin.id;
  const token = generateSessionToken();
  createSession(admin.id, hashSessionToken(token));
  sessionCookie = `${config.session.cookieName}=${token}`;

  ({ createApp } = await import('../../app.js'));
  server = createApp().listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  globalThis.fetch = realFetch;
  delete process.env.TELEGRAM_BOT_TOKEN_TEST;
  if (getDb) getDb().close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('P1 — zombie stop bound', () => {
  it('deactivating mid-round stops the round within the recheck bound (120 subscribers, nowhere near all of them sent)', async () => {
    resetPlan();
    seedSubscribers(120, 'zomb');
    plan.delayMs = 5;
    const b = makeRecurring();
    plan.onFirstSend = () => {
      expect(repo.transitionFromRecurring(b.id, 'completed')).toBe(true);
    };
    await worker.processDueRecurring();
    // Bound: at most one recheck window (50 launches) plus the in-flight
    // pool (10) — far below the 120 the old zombie would have sent.
    expect(sends.length).toBeGreaterThan(0);
    expect(sends.length).toBeLessThanOrEqual(
      worker.RECURRING_STATUS_RECHECK_EVERY + worker.RECURRING_SEND_CONCURRENCY
    );
    const row = repo.findBroadcastById(b.id);
    expect(row.status).toBe('completed');
    expect(row.sent_count).toBe(0); // aborted — never recorded
    const finished = roundsRepo.findLastFinishedRound(b.id);
    expect(finished).not.toBe(null); // the aborted round is closed honestly
    expect(finished.sent_count).toBe(sends.length);
  });
});

describe('P1 — atomic replace through the real endpoint', () => {
  it('without replaceActiveRecurring: 409 RECURRING_ALREADY_ACTIVE; with it: old completed + new recurring in one step; P4 fields appear on the list', async () => {
    resetPlan();
    seedSubscribers(3, 'repl');
    const old = makeRecurring();

    const basePayload = {
      bot: 'test',
      title: 'replacement',
      body: 'body',
      targetType: 'subscribers',
      recurring: true,
      recurringIntervalHours: 6
    };
    const blocked = await realFetch(`${baseUrl}/admin/broadcast/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify(basePayload)
    });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe('RECURRING_ALREADY_ACTIVE');

    const replaced = await realFetch(`${baseUrl}/admin/broadcast/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ ...basePayload, replaceActiveRecurring: true })
    });
    expect(replaced.status).toBe(201);
    const created = (await replaced.json()).broadcast;
    expect(created.status).toBe('recurring');
    // P2 — "Mulai sekarang" is anchored at activation time now.
    expect(created.recurringStartsAt).not.toBe(null);
    expect(repo.findBroadcastById(old.id).status).toBe('completed');
    expect(repo.findActiveRecurringBroadcast('test').id).toBe(created.id);

    // One real round so the P4 last-round shape has data, then the list.
    await worker.processDueRecurring();
    const listRes = await realFetch(`${baseUrl}/admin/broadcast/telegram?bot=test`, {
      headers: { cookie: sessionCookie }
    });
    expect(listRes.status).toBe(200);
    const rows = (await listRes.json()).broadcasts;
    const apiRow = rows.find((r) => r.id === created.id);
    expect(apiRow.recurringNextRoundAt).not.toBe(null); // P4 — jadwal berikutnya TERLIHAT
    expect(apiRow.recurringLastRound).not.toBe(null); // P4 — durasi putaran terakhir tersedia
    expect(apiRow.recurringLastRound.sentCount).toBe(3);
    expect(apiRow.recurringLastRound.startedAt).toBeTruthy();
    expect(apiRow.recurringLastRound.finishedAt).toBeTruthy();
    repo.transitionFromRecurring(created.id, 'completed');
  });
});

describe('P3 — resume from the cursor', () => {
  it('a worker restart mid-round resumes AFTER the cursor, never re-sending what was already delivered', async () => {
    resetPlan();
    const subs = seedSubscribers(6, 'rest');
    const b = makeRecurring();
    // Simulate "the process died mid-round": an open round whose cursor says
    // the first three were already delivered (exactly what persistProgress
    // leaves behind), then a fresh due-check — DB state is the only memory.
    const round = roundsRepo.createRound(b.id, new Date().toISOString());
    roundsRepo.updateRoundProgress(round.id, {
      cursorStartedAt: subs[2].started_at,
      cursorSubscriberId: subs[2].id,
      sentCount: 3,
      failedCount: 0
    });
    await worker.processDueRecurring();
    expect(sends.map((s) => s.chatId)).toEqual([subs[3].chat_id, subs[4].chat_id, subs[5].chat_id]);
    const row = repo.findBroadcastById(b.id);
    expect(row.sent_count).toBe(1);
    expect(row.recurring_last_round_sent_count).toBe(6); // 3 sebelum mati + 3 lanjutan
    repo.transitionFromRecurring(b.id, 'completed');
  });

  it('two subscribers with IDENTICAL started_at: the id tie break resumes exactly between them — neither skipped nor doubled', async () => {
    resetPlan();
    const seeded = seedSubscribers(4, 'tie');
    // Force subscribers #1 and #2 (by order) to share one started_at.
    getDb()
      .prepare('UPDATE telegram_subscribers SET started_at = ? WHERE id = ?')
      .run(seeded[0].started_at, seeded[1].id);
    const subs = subscribersRepo.listActiveSubscribers('test'); // deterministic: started_at ASC, id ASC
    expect(subs[0].started_at).toBe(subs[1].started_at);
    expect(subs[0].id < subs[1].id).toBe(true);

    const b = makeRecurring();
    const round = roundsRepo.createRound(b.id, new Date().toISOString());
    // Cursor at the FIRST of the identical pair.
    roundsRepo.updateRoundProgress(round.id, {
      cursorStartedAt: subs[0].started_at,
      cursorSubscriberId: subs[0].id,
      sentCount: 1,
      failedCount: 0
    });
    await worker.processDueRecurring();
    const got = sends.map((s) => s.chatId);
    expect(got).toEqual([subs[1].chat_id, subs[2].chat_id, subs[3].chat_id]); // pasangan kedua TIDAK terlewat
    expect(new Set(got).size).toBe(got.length); // dan tidak ada yang dobel
    expect(repo.findBroadcastById(b.id).recurring_last_round_sent_count).toBe(4);
    repo.transitionFromRecurring(b.id, 'completed');
  });
});

describe('P5 — throttle', () => {
  it('sends never exceed 25 started per second and never more than 10 in flight (60 subscribers)', async () => {
    resetPlan();
    seedSubscribers(60, 'thr');
    plan.delayMs = 300; // forces the pool to its in-flight cap
    const b = makeRecurring();
    await worker.processDueRecurring();
    expect(sends).toHaveLength(60);
    expect(maxInFlight).toBeLessThanOrEqual(worker.RECURRING_SEND_CONCURRENCY);
    // Sliding-window rate check over send START times is not directly
    // observable (the stub records completion), so check completion times:
    // completions can never outpace starts, and starts are token-bucketed.
    const times = sends.map((s) => s.at).sort((a, b2) => a - b2);
    for (let i = 0; i < times.length; i += 1) {
      let count = 0;
      for (let j = i; j < times.length && times[j] - times[i] < 1000; j += 1) count += 1;
      expect(count).toBeLessThanOrEqual(worker.RECURRING_SEND_RATE_PER_SECOND);
    }
    repo.transitionFromRecurring(b.id, 'completed');
  }, 30000);
});
