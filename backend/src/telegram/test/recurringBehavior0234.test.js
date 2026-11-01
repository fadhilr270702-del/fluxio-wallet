/**
 * Prompt 0234 — lahir di fase 1 sebagai REPRODUKSI perilaku lama (dari
 * gejala produksi 23–27 Oktober 2026; bukti DB/journal VM di arsip 0234),
 * lalu DIREVISI SADAR di fase 2: tes yang dulu membuktikan bug (zombie,
 * duplikat retry transport, anchor backfill) kini membuktikan perbaikannya
 * (P1/P2/P3); tes perilaku yang memang benar (starvation LIMIT 1, slot
 * anchor, isTicking) tetap apa adanya. Kasus beban/kursor lanjutan ada di
 * recurringRoundsFix0234.test.js.
 *
 * Pola harness: DB temp + token bot percobaan dummy + `globalThis.fetch`
 * distub (0233) — tidak ada request bisa mencapai Telegram, tidak ada
 * backend dispawn.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let getDb;
let tempDir;
let worker; // { tick, processDueRecurring }
let repo; // telegramBroadcastsRepo
let subscribersRepo;
let roundsRepo;
let computeRecurringDue;
let adminId;

// Stub fetch: hanya sendMessage yang pernah dipanggil (broadcast teks).
// `plan` dikontrol per tes: delay per kirim, kegagalan transport satu kali
// pada chat tertentu, dan sinyal "kirim pertama sudah mulai".
const sends = []; // { chatId, broadcastIdUnknown: false } — urutan kirim nyata
const plan = { delayMs: 0, failTransportOnceForChat: null, onFirstSend: null };
let firstSendSignalled = false;
let realFetch;

function installFetchStub() {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const reply = (result) => ({ json: async () => ({ ok: true, result }) });
    if (u.endsWith('/getUpdates')) return reply([]);
    if (u.endsWith('/sendMessage')) {
      const body = JSON.parse(options.body);
      if (!firstSendSignalled && plan.onFirstSend) {
        firstSendSignalled = true;
        plan.onFirstSend();
      }
      if (plan.delayMs > 0) await new Promise((r) => setTimeout(r, plan.delayMs));
      if (plan.failTransportOnceForChat === body.chat_id) {
        plan.failTransportOnceForChat = null; // sekali saja — percobaan berikutnya sukses
        throw new Error('fetch failed'); // bukan TelegramApiError => klasifikasi transport
      }
      sends.push(body.chat_id);
      return reply({ message_id: 9000 + sends.length });
    }
    throw new Error(`fetch tak terduga di recurringBehavior0234: ${u}`);
  };
}

function resetPlan() {
  sends.length = 0;
  plan.delayMs = 0;
  plan.failTransportOnceForChat = null;
  plan.onFirstSend = null;
  firstSendSignalled = false;
}

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function makeRecurring({ startsAt = isoAgo(60 * 60 * 1000), intervalHours = 1 } = {}) {
  return repo.createBroadcast({
    botId: 'test',
    title: 'repro 0234',
    body: 'body',
    targetType: 'subscribers',
    totalCount: 0,
    createdBy: adminId,
    recurring: true,
    recurringIntervalHours: intervalHours,
    recurringStartsAt: startsAt
  });
}

const H = 60 * 60 * 1000;

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'fluxio-recurring-0234-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
  process.env.TELEGRAM_BOT_TOKEN_TEST = '123456:recurring-0234-dummy';
  delete process.env.TELEGRAM_DISABLED;
  installFetchStub();

  const { runMigrations } = await import('../../db/migrate.js');
  runMigrations();
  ({ getDb } = await import('../../db/client.js'));
  worker = await import('../worker.js');
  repo = await import('../../db/repositories/telegramBroadcastsRepo.js');
  subscribersRepo = await import('../../db/repositories/telegramSubscribersRepo.js');
  roundsRepo = await import('../../db/repositories/telegramRecurringRoundsRepo.js');
  ({ computeRecurringDue } = await import('../recurringSchedule.js'));
  // created_by ber-FK ke admins(id) — butuh admin nyata (pola adminAnalyticsSummary.test.js).
  const { createAdmin } = await import('../../db/repositories/adminsRepo.js');
  adminId = createAdmin({ email: 'recurring-0234@example.com', passwordHash: 'unused-placeholder' }).id;

  // Tiga subscriber bot percobaan, urutan started_at menaik — persis urutan
  // kirim produksi (listActiveSubscribers ORDER BY started_at ASC).
  subscribersRepo.upsertFromStart({ botId: 'test', chatId: 'chatA', firstName: 'a' });
  subscribersRepo.upsertFromStart({ botId: 'test', chatId: 'chatB', firstName: 'b' });
  subscribersRepo.upsertFromStart({ botId: 'test', chatId: 'chatC', firstName: 'c' });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  delete process.env.TELEGRAM_BOT_TOKEN_TEST;
  if (getDb) getDb().close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('reproduksi 0234 — perilaku broadcast berulang SAAT INI', () => {
  it('(i) dua baris recurring aktif untuk SATU bot: worker hanya memproses SATU (LIMIT 1 tanpa ORDER BY) — yang lain kelaparan diam diam, bukan kirim ganda; pagar satu-aktif hanya hidup di controller', async () => {
    resetPlan();
    // createBroadcast (lapisan repo) TIDAK menolak baris recurring kedua —
    // pagar RECURRING_ALREADY_ACTIVE hanya ada di controller. Dua baris
    // status 'recurring' untuk bot yang sama terbentuk tanpa protes:
    const a = makeRecurring();
    const b = makeRecurring();
    expect(a.status).toBe('recurring');
    expect(b.status).toBe('recurring');

    await worker.processDueRecurring();

    // findActiveRecurringBroadcast = LIMIT 1 tanpa ORDER BY: tepat SATU
    // broadcast menjalankan putaran; tiap chat menerima tepat SEKALI.
    expect(sends).toEqual(['chatA', 'chatB', 'chatC']);
    const rowA = repo.findBroadcastById(a.id);
    const rowB = repo.findBroadcastById(b.id);
    const ran = [rowA, rowB].filter((r) => r.recurring_last_sent_at !== null);
    expect(ran).toHaveLength(1); // satu jalan, satu kelaparan diam diam
    repo.transitionFromRecurring(a.id, 'completed');
    repo.transitionFromRecurring(b.id, 'completed');
  });

  it('(ii) jadwal TIDAK bergeser — slot terpaku anchor; dan "Mulai sekarang" (fase 2, P2) kini di-anchor ke waktu AKTIVASI saat insert, bukan dibackfill waktu selesai putaran pertama', async () => {
    // (ii-a) murni: anchor 00:00, interval 6 jam, putaran selesai 00:30 →
    // slot berikutnya tetap 06:00 (bukan 06:30 — tidak ada drift).
    const anchor = '2026-10-26T00:00:00.000Z';
    const afterShortRound = computeRecurringDue('2026-10-26T00:30:00.000Z', anchor, 6 * H, Date.parse('2026-10-26T05:59:00.000Z'));
    expect(afterShortRound.due).toBe(false);
    expect(computeRecurringDue('2026-10-26T00:30:00.000Z', anchor, 6 * H, Date.parse('2026-10-26T06:00:01.000Z')).due).toBe(true);
    expect(afterShortRound.anchorForThisRound).toBe('2026-10-26T06:00:00.000Z');

    // (ii-b) fase 2 (P2): createBroadcast tanpa startsAt kini menganchor ke
    // WAKTU AKTIVASI di INSERT — perilaku fase 1 (anchor dibackfill dengan
    // waktu SELESAI putaran pertama, yang memaku kadensi ke durasi putaran)
    // sudah DIPERBAIKI; COALESCE di recordRecurringSend kini no-op untuk
    // baris baru (tinggal pertahanan legacy).
    const before = Date.now();
    const c = repo.createBroadcast({
      botId: 'test', title: 't', body: 'b', targetType: 'subscribers', totalCount: 0,
      createdBy: adminId, recurring: true, recurringIntervalHours: 6, recurringStartsAt: null
    });
    const anchorAtCreate = repo.findBroadcastById(c.id).recurring_starts_at;
    expect(anchorAtCreate).not.toBe(null);
    expect(Math.abs(Date.parse(anchorAtCreate) - before)).toBeLessThan(5000); // = waktu aktivasi
    const endOfRound = '2026-10-26T03:21:00.000Z';
    repo.recordRecurringSend(c.id, endOfRound, 3, 0);
    expect(repo.findBroadcastById(c.id).recurring_starts_at).toBe(anchorAtCreate); // COALESCE tidak menimpa
    repo.transitionFromRecurring(c.id, 'completed');
  });

  it('(iii-a) putaran lebih lama dari interval: slot yang terlewat DILEWATI (satu catch up, tidak menumpuk) — kadensi efektif melar ke slot berikutnya setelah putaran selesai', () => {
    const anchor = '2026-10-26T00:00:00.000Z';
    // Putaran slot 00:00 baru selesai 07:00 (7 jam > interval 6 jam):
    // slot 06:00 tidak dikejar ulang — jatuh tempo berikutnya 12:00.
    const r = computeRecurringDue('2026-10-26T07:00:00.000Z', anchor, 6 * H, Date.parse('2026-10-26T07:00:05.000Z'));
    expect(r.due).toBe(false);
    expect(r.anchorForThisRound).toBe('2026-10-26T12:00:00.000Z');
    expect(computeRecurringDue('2026-10-26T07:00:00.000Z', anchor, 6 * H, Date.parse('2026-10-26T12:00:01.000Z')).due).toBe(true);
  });

  it('(iii-b) tick TIDAK tumpang tindih (isTicking): dua tick serentak menghasilkan tepat satu putaran', async () => {
    resetPlan();
    plan.delayMs = 60; // tiap kirim lambat — tick pertama pasti masih jalan saat tick kedua masuk
    const d = makeRecurring();
    const [r1, r2] = await Promise.allSettled([worker.tick(), worker.tick()]);
    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('fulfilled');
    expect(sends).toEqual(['chatA', 'chatB', 'chatC']); // sekali per chat, tidak ganda
    repo.transitionFromRecurring(d.id, 'completed');
  });

  it('ZOMBIE DIPERBAIKI (pola 8ef3f851; fase 2, P1): putaran kecil (di bawah ambang recheck 50) masih selesai, TAPI hasilnya TIDAK PERNAH dicatat ke baris yang sudah dinonaktifkan — Sent tetap 0', async () => {
    resetPlan();
    plan.delayMs = 60;
    const e = makeRecurring();
    let deactivatedMidFlight = false;
    plan.onFirstSend = () => {
      // Persis yang pemilik lakukan di produksi: menonaktifkan broadcast
      // saat putarannya masih di tengah jalan.
      expect(repo.transitionFromRecurring(e.id, 'completed')).toBe(true);
      deactivatedMidFlight = true;
    };
    await worker.processDueRecurring();
    expect(deactivatedMidFlight).toBe(true);
    // 3 subscriber < ambang recheck 50, jadi putaran mungil ini tetap tuntas
    // (batas berhentinya ≤ 50 kirim — dibuktikan di recurringRoundsFix0234
    // dengan 120 subscriber); yang DIPERBAIKI di sini: statusnya tidak
    // pernah distempel lagi.
    expect(sends).toEqual(['chatA', 'chatB', 'chatC']);
    const row = repo.findBroadcastById(e.id);
    expect(row.status).toBe('completed');
    expect(row.sent_count).toBe(0); // fase 1 membuktikan 1 di sini — kini tidak pernah dicatat pasca deactivate
    expect(row.recurring_last_sent_at).toBe(null);
    // Jejak putarannya sendiri tetap jujur di tabel rounds.
    const finished = roundsRepo.findLastFinishedRound(e.id);
    expect(finished.sent_count).toBe(3);
  });

  it('DUPLIKAT RETRY TRANSPORT DIPERBAIKI (pola 9.317; fase 2, P2/P3): putaran gagal transport DILANJUTKAN dari kursor — tidak ada satu pun subscriber menerima dua kali', async () => {
    resetPlan();
    plan.failTransportOnceForChat = 'chatC'; // percobaan 1: A ok, B ok, C gagal transport → putaran gagal, kursor tersimpan di B
    const f = makeRecurring();
    await worker.processDueRecurring();
    expect(sends).toEqual(['chatA', 'chatB']); // putaran berhenti di transport
    expect(repo.findBroadcastById(f.id).recurring_last_sent_at).toBe(null); // belum sukses, belum distempel
    const open = roundsRepo.findOpenRound(f.id);
    expect(open).not.toBe(null);
    expect(open.cursor_subscriber_id).not.toBe(null); // kursor = chatB

    await worker.processDueRecurring(); // tick berikutnya: LANJUT dari kursor
    expect(sends).toEqual(['chatA', 'chatB', 'chatC']); // fase 1 membuktikan A dan B dobel di sini — kini sekali per chat
    const row = repo.findBroadcastById(f.id);
    expect(row.sent_count).toBe(1);
    expect(row.recurring_last_round_sent_count).toBe(3); // total putaran (2 + 1 lanjutan)
    expect(roundsRepo.findOpenRound(f.id)).toBe(null); // putaran tertutup
    repo.transitionFromRecurring(f.id, 'completed');
  });
});
