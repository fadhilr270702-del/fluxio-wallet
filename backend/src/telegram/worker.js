/**
 * Throttled drain of the telegram_broadcast_recipients queue — this is what
 * directly satisfies the "don't loop sendMessage directly, use a queue +
 * worker with throttling" requirement. One tick per TELEGRAM_WORKER_TICK_MS,
 * up to TELEGRAM_WORKER_BATCH_SIZE messages sent *sequentially* (never
 * Promise.all) per tick, with a small floor between sends — together these
 * cap throughput well under Telegram's ~30 msg/sec limit.
 *
 * Prompt 0138 (dual-bot foundation) — this worker now iterates every active
 * bot (BOT_IDS) for the recurring-broadcast check, and resolves each
 * queued/scheduled/channel broadcast's own Telegram client from that
 * broadcast row's own `bot_id` column rather than a single global client.
 * The queue itself (telegram_broadcast_recipients) and the due-scheduled
 * query stay deliberately UNSCOPED — one global claim/scan across every
 * bot's rows — since each row already carries (via its parent broadcast)
 * everything needed to resolve the right client; looping this per bot would
 * only add complexity for no behavioral difference (see
 * telegramBroadcastsRepo.js's own comment on this same choice).
 */
import { config } from '../config/env.js';
import { getTelegramClient, buildInlineKeyboard, TelegramApiError } from './client.js';
import { buildBroadcastMessage, resolveBroadcastMedia, degradeForChannel } from './formatting.js';
import { computeRecurringDue } from './recurringSchedule.js';
import { classifySendError, computeRoundOutcome } from './recurringRoundOutcome.js';
import { BOT_IDS } from './botIds.js';
import { ensureBroadcastMediaFileId, needsMediaResolution } from './broadcastMedia.js';
import {
  claimPendingBatch,
  markSent,
  markFailed,
  hasPendingForBroadcast,
  bulkInsertPending
} from '../db/repositories/telegramRecipientsRepo.js';
import {
  findBroadcastById,
  setStatus,
  incrementSentCount,
  incrementFailedCount,
  findDueScheduledBroadcasts,
  transitionFromScheduled,
  setTotalCount,
  markChannelSendResult,
  findActiveRecurringBroadcast,
  recordRecurringSend,
  updateMediaFileId
} from '../db/repositories/telegramBroadcastsRepo.js';
import { listActiveSubscribers, deactivateSubscriber } from '../db/repositories/telegramSubscribersRepo.js';
import {
  findOpenRound,
  createRound,
  updateRoundProgress,
  finishRound,
  resetRoundStart,
  parseResumeSkipIds
} from '../db/repositories/telegramRecurringRoundsRepo.js';

const MIN_SEND_SPACING_MS = 50;

// Prompt 0234 (P5/P1) — recurring-round throughput and the zombie-stop
// bound, ALL in this one place:
//  * concurrency: at most this many sends in flight at once (was strictly
//    sequential — a 15k round took 2 to 3 measured hours).
//  * rate: token bucket, sends STARTED per second, deliberately under
//    Telegram's ~30/s published limit.
//  * recheck: the broadcast's own status is re-read every this many
//    launches, so deactivating a broadcast stops its in-flight round within
//    this bound instead of hours later (the 8ef3f851 zombie-round incident).
export const RECURRING_SEND_CONCURRENCY = 10;
export const RECURRING_SEND_RATE_PER_SECOND = 25;
export const RECURRING_STATUS_RECHECK_EVERY = 50;

let intervalHandle = null;
let isTicking = false;
let pausedUntil = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Defensive against a corrupt row rather than crashing the tick loop over one bad broadcast. */
function parseButtons(broadcast) {
  try {
    return JSON.parse(broadcast.buttons || '[]');
  } catch {
    return [];
  }
}

/**
 * Prompt 0141 — the shared "does this broadcast's own bot already have a
 * file_id for its media" check every real send path below needs, right
 * before resolveBroadcastMedia(). A no-op (no Telegram call, no DB write)
 * whenever media_file_id is already set — the common case for anything
 * this bot itself originally composed, since uploadImage/uploadVideo
 * already resolve it eagerly at upload time. Only does real work for a
 * broadcast whose media arrived via a cross-bot "Salin ke form" copy that
 * has never been sent via THIS bot before — and even then, only the FIRST
 * recipient/round/tick that reaches it: ensureBroadcastMediaFileId() itself
 * caches the result, and this function persists it onto `broadcast.media_file_id`
 * in place, so every subsequent call with the SAME in-memory broadcast
 * object (e.g. later recipients in the same queue-drain batch, sharing one
 * cached object via tick()'s own broadcastCache) sees it already resolved
 * and skips straight past this check. Throws through to the caller's own
 * existing catch (TelegramApiError-shaped errors from
 * ensureBroadcastMediaFileId's own uploadPhoto/uploadVideo call are handled
 * identically to every other send failure already caught there; a plain
 * BroadcastMediaError — no client/no storage chat for this bot — surfaces
 * via its own `.message`, same as any other thrown Error those catches
 * already handle).
 */
async function resolveMediaForSend(broadcast) {
  if (!needsMediaResolution(broadcast)) return;
  const fileId = await ensureBroadcastMediaFileId(broadcast.bot_id, broadcast.media_server_filename, broadcast.media_type);
  updateMediaFileId(broadcast.id, fileId);
  broadcast.media_file_id = fileId;
}

async function sendToRecipient(broadcast, recipient) {
  const client = getTelegramClient(broadcast.bot_id);
  // Prompt 0193 — a queued row for a bot with no client used to fail with
  // the raw "Cannot read properties of null (reading 'sendPhoto')"; the
  // behavior stays the same (this recipient is marked failed once, no
  // retry loop) but the reason stored for the admin is now readable.
  if (!client) throw new Error(`bot '${broadcast.bot_id}' has no token configured in this process`);
  await resolveMediaForSend(broadcast);
  const { text, parseMode } = buildBroadcastMessage(broadcast);
  const replyMarkup = buildInlineKeyboard(parseButtons(broadcast));
  const media = resolveBroadcastMedia(broadcast);
  let result;
  if (media.type === 'video') {
    result = await client.sendVideo(recipient.chat_id, media.source, text, replyMarkup, parseMode);
  } else if (media.type === 'image') {
    result = await client.sendPhoto(recipient.chat_id, media.source, text, replyMarkup, parseMode);
  } else {
    result = await client.sendMessage(recipient.chat_id, text, replyMarkup, parseMode);
  }
  // Prompt 0140 — closes the "a completed send is silent" gap (see this
  // prompt's own incident archive) for the queue-drain path.
  console.log(`[telegram] broadcast sent: bot=${broadcast.bot_id} chat=${recipient.chat_id} message_id=${result.message_id} path=queue broadcast=${broadcast.id}`);
}

/**
 * Moves due `scheduled` broadcasts into the normal send flow. A plain
 * `scheduled_at <= now` match is catch-up-safe by construction — if the
 * server was down when a schedule passed, it's still "due" (however
 * overdue) the moment this runs after restart, so nothing is silently
 * skipped. Canceled broadcasts are simply never matched here (they're no
 * longer 'scheduled'), no special-casing needed.
 *
 * Race safety: every broadcast is claimed via transitionFromScheduled
 * (an atomic `UPDATE ... WHERE status='scheduled'`) BEFORE any further
 * work — for the channel branch, before the awaited Telegram API call;
 * for the subscribers branch, before the queue snapshot is written. This
 * is the same function the cancel endpoint uses, so whichever side reaches
 * a given broadcast first legitimately wins and the other becomes a no-op.
 */
async function activateDueScheduled() {
  const due = findDueScheduledBroadcasts(new Date().toISOString());

  for (const broadcast of due) {
    if (broadcast.target_type === 'channel') {
      if (!transitionFromScheduled(broadcast.id, 'sending')) continue; // already canceled/claimed elsewhere
      const client = getTelegramClient(broadcast.bot_id);
      try {
        // Prompt 0193 — same readable-reason guard as sendToRecipient():
        // thrown INSIDE the try so it flows through the existing failure
        // path (markChannelSendResult below), never out of tick().
        if (!client) throw new Error(`bot '${broadcast.bot_id}' has no token configured in this process`);
        await resolveMediaForSend(broadcast);
        const built = buildBroadcastMessage(broadcast);
        const { parseMode } = built;
        // Prompt 0153 — this is a channel target; strip premium-emoji
        // content before it ever leaves this process (see formatting.js's
        // own degradeForChannel() header).
        const { text, replyMarkup } = degradeForChannel({
          text: built.text,
          replyMarkup: buildInlineKeyboard(parseButtons(broadcast))
        });
        const media = resolveBroadcastMedia(broadcast);
        let result;
        if (media.type === 'video') {
          result = await client.sendVideo(broadcast.target_channel_id, media.source, text, replyMarkup, parseMode);
        } else if (media.type === 'image') {
          result = await client.sendPhoto(broadcast.target_channel_id, media.source, text, replyMarkup, parseMode);
        } else {
          result = await client.sendMessage(broadcast.target_channel_id, text, replyMarkup, parseMode);
        }
        console.log(`[telegram] broadcast sent: bot=${broadcast.bot_id} chat=${broadcast.target_channel_id} message_id=${result.message_id} path=scheduled-channel broadcast=${broadcast.id}`);
        markChannelSendResult(broadcast.id, { success: true });
      } catch (err) {
        markChannelSendResult(broadcast.id, { success: false, errorMessage: err.message });
      }
      continue;
    }

    // targetType === 'subscribers': snapshot who's active *now* (activation
    // time, not compose time — more accurate to who's actually reachable
    // when the message goes out), scoped to this broadcast's own bot.
    const subscribers = listActiveSubscribers(broadcast.bot_id);
    if (!transitionFromScheduled(broadcast.id, 'queued')) continue; // already canceled/claimed elsewhere
    setTotalCount(broadcast.id, subscribers.length);
    if (subscribers.length === 0) {
      setStatus(broadcast.id, 'completed');
      continue;
    }
    bulkInsertPending(broadcast.id, subscribers);
  }
}

/**
 * Sends one round of a recurring broadcast. Prompt 0134 Revision 1: this
 * used to also be called synchronously from the create controller (for the
 * "first send happens immediately on activation" requirement) — that was
 * the direct cause of a real duplicate-send bug (see this prompt's own
 * archive for the reproduced log), since a concurrent worker tick could
 * read the same still-NULL recurring_last_sent_at while that synchronous
 * call was still awaiting its own network request. Fixed by removing that
 * second call site entirely — processDueRecurring() below is now the ONLY
 * caller, for every round of a recurring broadcast including the first
 * (a NULL recurring_last_sent_at already reads as "due now"), so there is
 * structurally no other caller left to race against.
 *
 * Deliberately bypasses the telegram_broadcast_recipients queue entirely —
 * that queue's own completion logic (see the bottom of tick() below) flips
 * a broadcast's status to 'completed'/'partial' once it drains, which would
 * fight a recurring broadcast's own status staying 'recurring' indefinitely
 * across many rounds. A channel round is a single message, exactly like
 * activateDueScheduled()'s own channel branch; a subscribers round loops
 * over everyone *currently* active (re-snapshotted fresh each round, not
 * cached from activation time) sequentially with the same MIN_SEND_SPACING_MS
 * floor and 403-deactivation/429-pause handling the queue-drain loop below
 * already uses — reused here rather than duplicated with different
 * semantics.
 *
 * Returns `{ success, sentCount, failedCount, failureReason }` — see
 * recurringRoundOutcome.js's own computeRoundOutcome() for the full
 * decision table. Prompt 0166, replacing this comment's own pre-0166
 * claim ("the round counts as sent even if some individual recipients
 * failed... since most likely succeeded"): that claim is exactly what let
 * a real incident happen — a round with ZERO successful sends (every
 * attempt a network/transport failure) was still recorded as "sent". Now:
 * a 429 still fails the round (unchanged); a transport-class error (no
 * valid Telegram response received at all — DNS failure, reset
 * connection, timeout, `fetch failed`) fails the round IMMEDIATELY,
 * stopping the loop rather than continuing to the next recipient; and
 * even when the loop runs to completion, a round with subscribers but
 * zero successful deliveries is now also treated as failed. Only an
 * individual recipient's own Telegram-answered failure (403 blocked, 400
 * chat not found, etc.) is still "that recipient's own problem, keep
 * going" — the round can still succeed with some, but not zero, delivered.
 * A failed round writes nothing to the DB (see recordRecurringSend's own
 * comment on why NOT advancing recurring_last_sent_at on failure is
 * exactly what makes "retry next tick" work with no extra bookkeeping).
 *
 * One console.log summary line per round, success or failure (prompt
 * 0166 item 4 — the user has deliberately chosen no log file, so this
 * stays the one place to see how a round actually went).
 */
export async function sendRecurringRound(broadcast) {
  const client = getTelegramClient(broadcast.bot_id);
  // Resolved once per round (not once per subscriber below) — same
  // "upload once, not per chat" contract as the queue-drain/scheduled-
  // channel paths, just naturally satisfied here since this whole round
  // already shares one buildBroadcastMessage()/resolveBroadcastMedia() call.
  // Wrapped in its own try/catch, same "a failed round retries next tick,
  // from scratch" contract every other failure mode in this function
  // already has — a media-resolution failure here must fail only THIS
  // round, never propagate up and abort the rest of the worker's own tick
  // (processDueRecurring/activateDueScheduled/the queue-drain batch all
  // still need to run this tick regardless of one recurring broadcast's
  // own media trouble).
  try {
    await resolveMediaForSend(broadcast);
  } catch (err) {
    console.warn(`[telegram] recurring broadcast ${broadcast.id}: could not resolve media for sending: ${err.message}`);
    return { success: false };
  }
  const { text, parseMode } = buildBroadcastMessage(broadcast);
  const replyMarkup = buildInlineKeyboard(parseButtons(broadcast));
  const media = resolveBroadcastMedia(broadcast);

  // Prompt 0153 — text/replyMarkup are now explicit REQUIRED params (rather
  // than reading the outer text/replyMarkup via closure) specifically so
  // the channel branch below can pass its own degraded values without any
  // risk of the subscribers branch further down accidentally inheriting
  // them, or vice versa — see degradeForChannel()'s own header for why a
  // channel target must never receive premium-emoji content.
  async function sendOne(chatId, sendText, sendReplyMarkup) {
    let result;
    if (media.type === 'video') result = await client.sendVideo(chatId, media.source, sendText, sendReplyMarkup, parseMode);
    else if (media.type === 'image') result = await client.sendPhoto(chatId, media.source, sendText, sendReplyMarkup, parseMode);
    else result = await client.sendMessage(chatId, sendText, sendReplyMarkup, parseMode);
    console.log(`[telegram] broadcast sent: bot=${broadcast.bot_id} chat=${chatId} message_id=${result.message_id} path=recurring broadcast=${broadcast.id}`);
    return result;
  }

  // One summary line per round regardless of outcome/target type — the
  // single place a user with no log file configured can see how a round
  // actually went (prompt 0166 item 4).
  function logRoundSummary(outcome) {
    const reasonPart = outcome.failureReason ? ` roundFailed=${outcome.failureReason}` : '';
    console.log(`[telegram] recurring round summary: broadcast=${broadcast.id} sent=${outcome.sentCount} failed=${outcome.failedCount}${reasonPart}`);
  }

  // target_type === 'channel' — deliberately UNTOUCHED by this prompt's own
  // accounting fix (item 6's explicit "jalur channel-target TIDAK
  // disentuh"): any error at all already failed the round before 0166 and
  // still does now, transport-class or not — a channel round is exactly
  // one message, so there's no "some recipients, some not" case for it to
  // begin with. Only wrapped in the same outcome shape (sentCount/
  // failedCount/failureReason) so processDueRecurring() and the summary
  // log below have one uniform return contract across both branches.
  if (broadcast.target_type === 'channel') {
    const degraded = degradeForChannel({ text, replyMarkup });
    let outcome;
    try {
      await sendOne(broadcast.target_channel_id, degraded.text, degraded.replyMarkup);
      outcome = { success: true, sentCount: 1, failedCount: 0, failureReason: null };
    } catch (err) {
      let failureReason = 'channel_error';
      if (err instanceof TelegramApiError && err.errorCode === 429) {
        const retryAfterSeconds = err.retryAfter ?? 5;
        pausedUntil = Date.now() + retryAfterSeconds * 1000 + 1000;
        console.warn(`[telegram] recurring broadcast ${broadcast.id}: rate-limited, pausing worker for ${retryAfterSeconds}s`);
        failureReason = 'rate_limited';
      } else {
        console.warn(`[telegram] recurring broadcast ${broadcast.id}: channel send failed: ${err.message}`);
      }
      outcome = { success: false, sentCount: 0, failedCount: 0, failureReason };
    }
    logRoundSummary(outcome);
    return outcome;
  }

  // target_type === 'subscribers' — prompt 0234 rewrite (P1/P3/P5), on top
  // of the same fresh re-snapshot reasoning as before. The round itself is
  // now a durable row (telegram_recurring_rounds): an interrupted round
  // RESUMES from its cursor instead of re-sending from scratch (the 9.317
  // real duplicate sends of 26 Oktober 2026), deactivation stops an
  // in-flight round within RECURRING_STATUS_RECHECK_EVERY launches (the
  // zombie-round incident), and sends go out through a bounded parallel
  // pool under a token bucket instead of strictly sequentially (a measured
  // 2 to 3 hours for 15k subscribers).
  const subscribers = listActiveSubscribers(broadcast.bot_id);
  const hadSubscribers = subscribers.length > 0;

  // P3 — resume the open round if one exists, else open a fresh one.
  const round = findOpenRound(broadcast.id) ?? createRound(broadcast.id, new Date().toISOString());
  const priorSent = round.sent_count;
  const priorFailed = round.failed_count;
  const skipIds = parseResumeSkipIds(round);
  let startIndex = 0;
  if (round.cursor_started_at) {
    // The order is deterministic (started_at ASC, id ASC — see
    // listActiveSubscribers), so "after the cursor" is exact even when two
    // subscribers share one started_at.
    startIndex = subscribers.findIndex(
      (s) =>
        s.started_at > round.cursor_started_at ||
        (s.started_at === round.cursor_started_at && s.id > round.cursor_subscriber_id)
    );
    if (startIndex === -1) startIndex = subscribers.length;
  }

  // P5 — rate limiter: a strict minimum spacing between send STARTS
  // (1000 / rate ms), deliberately NOT a burstable token bucket — a bucket
  // with capacity N allows N back-to-back starts after any pause, which
  // breaks the "never more than rate per second in ANY window" guarantee
  // this exists to give (caught by this prompt's own throttle test).
  const startSpacingMs = Math.ceil(1000 / RECURRING_SEND_RATE_PER_SECOND);
  let nextAllowedStart = 0;
  async function takeToken() {
    for (;;) {
      const now = Date.now();
      if (now >= nextAllowedStart) {
        nextAllowedStart = now + startSpacingMs;
        return;
      }
      await sleep(nextAllowedStart - now);
    }
  }

  // Per-index results: 'success' | 'recipient_error' | 'skipped_prior'
  // (delivered on an EARLIER attempt of this same round) | undefined (never
  // attempted, or a transport/429 attempt — those must be retried, so they
  // deliberately never settle an index).
  const results = new Array(subscribers.length);
  let attemptSent = 0;
  let attemptFailed = 0;
  let stoppedEarlyBy = null;
  let abortedDeactivated = false;

  // Persists how far this round provably got: the cursor is the end of the
  // CONTIGUOUS attempted prefix; anything delivered beyond a gap (parallel
  // in-flight sends that landed after a transport/429 hit an earlier index)
  // goes into the resume-skip list so it is never re-sent — see migration
  // 0027's own header.
  function persistProgress() {
    let contiguous = startIndex;
    while (contiguous < subscribers.length && results[contiguous] !== undefined) contiguous += 1;
    const resumeSkipIds = [];
    for (let i = contiguous; i < subscribers.length; i += 1) {
      if (results[i] === 'success' || results[i] === 'skipped_prior') resumeSkipIds.push(subscribers[i].id);
    }
    const last =
      contiguous > startIndex
        ? subscribers[contiguous - 1]
        : round.cursor_started_at
          ? { started_at: round.cursor_started_at, id: round.cursor_subscriber_id }
          : null;
    updateRoundProgress(round.id, {
      cursorStartedAt: last ? last.started_at : null,
      cursorSubscriberId: last ? last.id : null,
      sentCount: priorSent + attemptSent,
      failedCount: priorFailed + attemptFailed,
      resumeSkipIds
    });
  }

  async function runOne(index) {
    const subscriber = subscribers[index];
    try {
      await sendOne(subscriber.chat_id, text, replyMarkup);
      results[index] = 'success';
      attemptSent += 1;
    } catch (err) {
      const classification = classifySendError(err);
      if (classification === 'rate_limited') {
        // P5 — the pause is GLOBAL (pausedUntil blocks the whole worker's
        // next ticks), not just this one message; the round stays open and
        // resumes from its cursor once the pause lifts.
        const retryAfterSeconds = err.retryAfter ?? 5;
        pausedUntil = Date.now() + retryAfterSeconds * 1000 + 1000;
        console.warn(`[telegram] recurring broadcast ${broadcast.id}: rate-limited mid-round, pausing worker for ${retryAfterSeconds}s`);
        stoppedEarlyBy = stoppedEarlyBy ?? 'rate_limited';
        return;
      }
      if (classification === 'transport') {
        // Prompt 0166's immediate stop, kept — but prompt 0234 (P2/P3)
        // changes what happens NEXT: the round is left OPEN with its cursor
        // persisted, so the retry RESUMES instead of re-sending from
        // scratch.
        console.warn(`[telegram] recurring broadcast ${broadcast.id}: transport error mid-round, stopping immediately: ${err.message}`);
        stoppedEarlyBy = stoppedEarlyBy ?? 'transport';
        return;
      }
      // 'recipient' — Telegram answered; this one chat just can't be
      // reached. Unchanged from pre-0234 (403 deactivates the subscriber).
      if (err instanceof TelegramApiError && err.errorCode === 403) {
        deactivateSubscriber(subscriber.id);
      }
      console.warn(`[telegram] recurring broadcast ${broadcast.id}: failed to reach subscriber ${subscriber.chat_id}: ${err.message}`);
      results[index] = 'recipient_error';
      attemptFailed += 1;
    }
  }

  // P1 — never even start a round for a broadcast that is no longer
  // 'recurring' (replace/deactivate landed between the due-check and here).
  if (findBroadcastById(broadcast.id)?.status !== 'recurring') {
    abortedDeactivated = true;
  }

  const inFlight = new Set();
  let launchedSinceRecheck = 0;
  for (let index = startIndex; index < subscribers.length; index += 1) {
    if (stoppedEarlyBy || abortedDeactivated) break;
    if (skipIds.has(subscribers[index].id)) {
      results[index] = 'skipped_prior'; // delivered on an earlier attempt of this round — never re-sent
      continue;
    }
    // P1 — the zombie stop: re-read the broadcast's own status every
    // RECURRING_STATUS_RECHECK_EVERY launches.
    if (launchedSinceRecheck >= RECURRING_STATUS_RECHECK_EVERY) {
      launchedSinceRecheck = 0;
      if (findBroadcastById(broadcast.id)?.status !== 'recurring') {
        abortedDeactivated = true;
        break;
      }
    }
    await takeToken();
    if (stoppedEarlyBy || abortedDeactivated) break; // may have changed while waiting for a token
    const p = runOne(index);
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
    launchedSinceRecheck += 1;
    if (inFlight.size >= RECURRING_SEND_CONCURRENCY) {
      await Promise.race([...inFlight]);
    }
  }
  await Promise.all([...inFlight]); // settle whatever is still in flight
  persistProgress();

  const totalSent = priorSent + attemptSent;
  const totalFailed = priorFailed + attemptFailed;

  if (abortedDeactivated) {
    // P1 — the round of a deactivated broadcast stops here, is closed for
    // the history record, and recordRecurringSend is NEVER reached (the
    // caller only records a success).
    console.log(`[telegram] recurring round aborted: deactivated at sent=${totalSent} broadcast=${broadcast.id}`);
    finishRound(round.id, new Date().toISOString(), totalSent, totalFailed);
    const outcome = { success: false, sentCount: totalSent, failedCount: totalFailed, failureReason: 'deactivated' };
    logRoundSummary(outcome);
    return outcome;
  }

  // 0166's decision table judges THIS attempt; the round verdict is over
  // the round's TOTALS (a resumed round whose remainder was all recipient
  // errors still succeeded if an earlier attempt delivered).
  const attempts = [];
  for (let i = startIndex; i < subscribers.length; i += 1) {
    if (results[i] === 'success') attempts.push('success');
    else if (results[i] === 'recipient_error') attempts.push('recipient_error');
  }
  const attemptOutcome = computeRoundOutcome(attempts, { stoppedEarlyBy, hadSubscribers });
  let failureReason = attemptOutcome.failureReason;
  if (failureReason === 'zero_delivered' && totalSent > 0) failureReason = null;
  const outcome = { success: failureReason == null, sentCount: totalSent, failedCount: totalFailed, failureReason };

  if (outcome.success || failureReason === 'zero_delivered') {
    // Success closes the round; so does a fully-walked round that delivered
    // to no one (there is no cursor to resume — the next slot opens a fresh
    // round via processDueRecurring's own gate). transport/rate_limited
    // deliberately leave the round OPEN for the cursor resume.
    finishRound(round.id, new Date().toISOString(), totalSent, totalFailed);
  }
  logRoundSummary(outcome);
  return outcome;
}

/**
 * Checks the (at most one) active recurring broadcast per bot and fires the
 * next round once its own anchor-based next slot has been reached — see
 * recurringSchedule.js's own computeRecurringDue() for the full slot
 * arithmetic and catch-up policy. Prompt 0134 Revision 1: this is now the
 * ONLY place that ever calls sendRecurringRound(), including for a
 * broadcast's very first round right after activation — the create
 * controller used to also send that first round itself, synchronously,
 * which raced against this exact tick (see sendRecurringRound's own updated
 * comment, and this prompt's archive for the reproduced duplicate-send
 * log). A null recurring_last_sent_at (never sent yet — always true for a
 * few hundred ms to ~1 tick right after activation, and also possible if a
 * round genuinely failed) is treated as "already due" once its own
 * recurring_starts_at anchor (if any) has been reached — matching the exact
 * same catch-up-safe `<=`-style comparison activateDueScheduled() uses for
 * one-time schedules — this is what makes both "first send happens promptly
 * once its start time arrives" (at most one tick's delay, workerTickMs — 1
 * second by default) and "a failed round retries next tick" work via the
 * same one rule, no special-casing needed.
 *
 * Prompt 0164 — interval is now PER BROADCAST (recurring_interval_hours,
 * admin-chosen 1..24 at activation — was a single fixed global
 * RECURRING_INTERVAL_MS env value shared by every recurring broadcast).
 * `config.telegram.recurringIntervalMs` is kept only as a defensive
 * fallback for the — should be structurally unreachable — case of a row
 * whose own recurring_interval_hours is falsy despite the column's own
 * NOT NULL DEFAULT 1 constraint (e.g. a row inserted via raw SQL bypassing
 * the app layer entirely); every row read back through this repository
 * layer already always has a real 1..24 value, so in practice this
 * fallback never actually triggers for a broadcast created through the
 * app. Kept rather than deleted purely as defense-in-depth, not because any
 * real row still needs it.
 *
 * Restart-safety (the "one catch-up send, not a burst" requirement): this
 * reads recurring_last_sent_at/recurring_starts_at fresh from the DB every
 * tick rather than tracking anything in memory, so a server restart
 * naturally resumes correctly — if several rounds were missed while the
 * server was down, computeRecurringDue()'s own anchor-slot arithmetic
 * collapses that into exactly one catch-up send, then resumes the regular
 * cadence pinned to the ORIGINAL anchor; because recordRecurringSend()
 * stamps recurring_last_sent_at with the real current time (not "when it
 * was originally due"), the very next due-check correctly measures from
 * that fresh timestamp against the anchor, never firing a second time to
 * "catch up" further.
 *
 * Prompt 0138 — "at most one active recurring broadcast" is now enforced
 * PER BOT (see telegramBroadcastsRepo.js's findActiveRecurringBroadcast),
 * so this checks every bot id in turn rather than assuming a single global
 * active broadcast. Each bot's own round is still awaited sequentially
 * within the same tick (never Promise.all) — this is what the shared
 * `isTicking` guard's own comment below means by "a strict superset of
 * no-double-send-per-bot": one slow bot's round delays the OTHER bot's
 * check within this same tick, which is more conservative than strictly
 * necessary but far simpler than tracking concurrency independently per
 * bot, and was explicitly permitted by this prompt's own design brief.
 */
// Prompt 0193 — one skip line per (botId, broadcast id) per PROCESS, not
// per tick: the 6 September 2026 production incident printed a failed
// "transport error mid-round" line EVERY SECOND (599 lines per 10
// minutes) because the migrated production DB carried an active recurring
// broadcast for the 'test' bot, which has no token on the VM —
// getTelegramClient() returned null, sendRecurringRound() failed as a
// transport-class error, and the deliberate no-DB-write-on-failure design
// made it due again on the very next 1s tick, forever. A process restart
// resetting this set is fine — one fresh line per restart is signal, not
// noise.
const loggedSkippedRecurring = new Set();

// Exported for tests only (prompt 0193) — the worker's own tick() remains
// the single real caller.
export async function processDueRecurring() {
  for (const botId of BOT_IDS) {
    const active = findActiveRecurringBroadcast(botId);
    if (!active) continue;

    // Prompt 0193 — the null-client fence (see the incident note above):
    // never attempt the round, never touch the DB, so the broadcast stays
    // 'recurring' with its last_sent_at untouched and resumes on its own
    // the moment this bot has a token again (e.g. a redeploy with the
    // token configured). Genuine network/transport failures for a bot
    // that DOES have a client keep the existing retry-next-tick design —
    // this fence is only for a structurally absent client.
    if (!getTelegramClient(botId)) {
      const skipKey = `${botId}:${active.id}`;
      if (!loggedSkippedRecurring.has(skipKey)) {
        loggedSkippedRecurring.add(skipKey);
        console.log(
          `[telegram] bot '${botId}' has no token configured in this process — active recurring broadcast ${active.id} skipped (not attempted, not modified); it resumes automatically once the bot has a token`
        );
      }
      continue;
    }

    const intervalMs = active.recurring_interval_hours ? active.recurring_interval_hours * 60 * 60 * 1000 : config.telegram.recurringIntervalMs;

    // Prompt 0234 (P2/P3) — the due-check now distinguishes an interrupted
    // round from a fresh slot:
    //  * open round WITH a cursor (something was already delivered this
    //    round) → resume on the very next tick, regardless of slot — the
    //    cursor makes that duplicate-free, so there is no reason to wait.
    //  * open round WITHOUT a cursor (the attempt delivered nothing, e.g. a
    //    transport failure on the very first send) → wait for the NEXT slot
    //    after that attempt started (the pre-0234 behavior retried the
    //    whole round one second later, forever — see the 0193 incident the
    //    null-client fence above was born from); the fresh attempt restarts
    //    the round's own clock for an honest duration record.
    //  * no open round → the plain anchor-slot arithmetic, unchanged.
    const openRound = findOpenRound(active.id);
    let due;
    if (openRound) {
      if (openRound.cursor_started_at) {
        due = true;
      } else {
        const anchorMs = active.recurring_starts_at ? Date.parse(active.recurring_starts_at) : null;
        const roundStartMs = Date.parse(openRound.started_at);
        const nextSlotMs =
          anchorMs != null
            ? anchorMs + (Math.floor((roundStartMs - anchorMs) / intervalMs) + 1) * intervalMs
            : roundStartMs + intervalMs;
        due = Date.now() >= nextSlotMs;
        if (due) resetRoundStart(openRound.id, new Date().toISOString());
      }
    } else {
      ({ due } = computeRecurringDue(active.recurring_last_sent_at, active.recurring_starts_at, intervalMs));
    }
    if (!due) continue;

    const result = await sendRecurringRound(active);
    if (result.success) {
      // Prompt 0234 (P1) — never stamp a broadcast that was deactivated
      // while its round ran: the pre-0234 code wrote "Sent 1×" onto an
      // already-completed row (the real 8ef3f851 wart). A small round
      // (shorter than the in-round recheck bound) can still finish after a
      // deactivation; its result is simply not recorded.
      if (findBroadcastById(active.id)?.status === 'recurring') {
        // Prompt 0166 — also persists this round's own sent/failed counts
        // (recurring_last_round_sent_count/_failed_count) for the admin
        // panel; see telegramBroadcastsRepo.js's recordRecurringSend().
        recordRecurringSend(active.id, new Date().toISOString(), result.sentCount, result.failedCount);
      } else {
        console.log(`[telegram] recurring round finished after deactivation: not recorded broadcast=${active.id}`);
      }
    }
    // On transport/rate-limit failure: no broadcast-row write — the OPEN
    // round row (with its cursor) is the retry state now, so the resume is
    // duplicate-free instead of a from-scratch re-send.
  }
}

// Prompt 0134 Revision 1 — `isTicking` predates the recurring feature (it
// was originally here to stop the queue-drain loop below from overlapping
// itself), but it guards this ENTIRE function body, set to true BEFORE
// processDueRecurring() runs and only reset in the `finally` below, after
// everything in one tick — including a recurring round — has finished. A
// recurring send slower than one workerTickMs (e.g. Telegram network
// latency, or a large photo/video) therefore already can't race a
// concurrent tick the same way activation's own synchronous send used to:
// every `setInterval` callback that fires while a tick is still in flight
// sees `isTicking === true` here and returns immediately, without ever
// re-entering processDueRecurring(). Proven directly, not just reasoned
// about: an artificial 3.5s send delay (well over the 1s default tick)
// produced 4 skipped overlapping ticks and exactly one real send — see
// this prompt's own archive for the full log.
//
// Prompt 0138 (dual-bot foundation) — deliberately kept as ONE global flag,
// not one per bot, even though processDueRecurring() now loops over every
// bot id. The actually-required property is "no double-send for the SAME
// bot's SAME broadcast" — a single global flag is a strict superset of
// that (it also prevents bot A's and bot B's ticks from ever overlapping
// each other, which isn't strictly necessary), but it's far simpler than
// tracking per-bot concurrency state, and the base prompt's own design
// brief explicitly allowed this ("nilai per keseluruhan tick boleh, asal
// tidak ada dobel kirim per bot"). The cost is real but small: bot B's
// recurring check/queue drain waits for bot A's to finish within the same
// tick, a delay bounded by one workerTickMs in the worst case, not a
// correctness issue.
// Exported for tests only (prompt 0193) — startBroadcastWorker()'s
// setInterval remains the single real caller.
export async function tick() {
  if (isTicking || Date.now() < pausedUntil) return;
  isTicking = true;
  try {
    await processDueRecurring();
    await activateDueScheduled();

    const batch = claimPendingBatch(config.telegram.workerBatchSize);
    if (batch.length === 0) return;

    const broadcastCache = new Map();
    const touchedBroadcastIds = new Set();

    for (const recipient of batch) {
      touchedBroadcastIds.add(recipient.broadcast_id);

      let broadcast = broadcastCache.get(recipient.broadcast_id);
      if (broadcast === undefined) {
        broadcast = findBroadcastById(recipient.broadcast_id);
        broadcastCache.set(recipient.broadcast_id, broadcast);
        if (broadcast && broadcast.status === 'queued') {
          setStatus(broadcast.id, 'sending');
        }
      }
      if (!broadcast) {
        // Shouldn't happen (FK constraint), but never crash the worker over one bad row.
        markFailed(recipient.id, 'Parent broadcast not found.');
        continue;
      }

      try {
        await sendToRecipient(broadcast, recipient);
        markSent(recipient.id);
        incrementSentCount(broadcast.id);
      } catch (err) {
        if (err instanceof TelegramApiError && err.errorCode === 429) {
          const retryAfterSeconds = err.retryAfter ?? 5;
          pausedUntil = Date.now() + retryAfterSeconds * 1000 + 1000;
          console.warn(`[telegram] rate-limited by Telegram, pausing worker for ${retryAfterSeconds}s`);
          break; // this and any remaining rows in the batch stay 'pending' for a later tick
        }
        if (err instanceof TelegramApiError && err.errorCode === 403) {
          // Bot was blocked/kicked by this chat — stop sending to them from now on.
          deactivateSubscriber(recipient.subscriber_id);
        }
        markFailed(recipient.id, err.message);
        incrementFailedCount(broadcast.id);
      }

      await sleep(MIN_SEND_SPACING_MS);
    }

    for (const broadcastId of touchedBroadcastIds) {
      if (hasPendingForBroadcast(broadcastId)) continue;
      const finalBroadcast = findBroadcastById(broadcastId);
      if (finalBroadcast && (finalBroadcast.status === 'queued' || finalBroadcast.status === 'sending')) {
        setStatus(broadcastId, finalBroadcast.failed_count > 0 ? 'partial' : 'completed');
      }
    }
  } finally {
    isTicking = false;
  }
}

// Prompt 0138 — the worker itself is a single shared loop across every bot
// (see this file's own header comment on why the queue/schedule scan stays
// unscoped), so it only needs to skip starting entirely when NO bot has a
// token configured at all — there'd be nothing for it to ever do. Once
// running, a specific bot with no token simply never has any due/queued
// rows of its own to begin with (nothing could have created one — every
// controller checks getTelegramClient(botId) before creating a broadcast),
// so no per-bot skip is needed inside the loop itself.
export function startBroadcastWorker() {
  const anyBotConfigured = BOT_IDS.some((botId) => Boolean(getTelegramClient(botId)));
  if (!anyBotConfigured) {
    console.log('[telegram] no bot has a token configured — broadcast worker not started.');
    return;
  }
  console.log('[telegram] broadcast worker started.');
  intervalHandle = setInterval(() => {
    tick().catch((err) => console.error('[telegram] worker tick error:', err));
  }, config.telegram.workerTickMs);
}

export function stopBroadcastWorker() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
