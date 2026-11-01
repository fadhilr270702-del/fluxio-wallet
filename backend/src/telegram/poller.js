/**
 * Subscriber intake via long-polling (not a webhook — a webhook needs a
 * public HTTPS URL, which this dev setup has no tunnel/ngrok infra for).
 * A self-rescheduling loop, not setInterval: getUpdates itself blocks for
 * up to the poll timeout, so an interval-based tick could fire a second
 * call before the first one returns.
 *
 * Prompt 0138 (dual-bot foundation) — every function here now takes an
 * explicit botId and operates on that one bot's own client/offset/
 * subscribers only. server.js starts one independent poller loop per
 * active bot (see startTelegramPoller() below) — there's no shared state
 * between them beyond the module-level `stoppedFlags` map, keyed by bot id,
 * so one bot's poller stopping/erroring never affects the other's.
 */
import { config } from '../config/env.js';
import { getTelegramClient } from './client.js';
import { upsertFromStart, recordWelcomeSent, findSubscriberByChatId } from '../db/repositories/telegramSubscribersRepo.js';
import { getOffset, setOffset } from '../db/repositories/telegramPollStateRepo.js';
import { sendWelcomeMessage, shouldSendWelcome } from './welcome.js';
import {
  parseStartPayload,
  isHelpCommand,
  HELP_MESSAGE_TEXT,
  isUnknownPrivateMessage,
  AUTO_REPLY_TEXT,
  AUTO_REPLY_WINDOW_MS
} from './startCommands.js';

const stoppedFlags = new Map();

// Prompt 0236 — anti-spam state for the unknown-message auto reply: the
// last successful reply per (botId, chatId). Deliberately IN MEMORY, not a
// column: the worst a restart can cost is one extra polite reply to a chat
// that messaged again within 10 minutes — not worth a schema change or a
// per-message write. Entries are pruned once the map grows past a bound.
const lastAutoReplyAt = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `fetchUpdatesFn` (prompt 0135, still supported in 0138) defaults to the
 * resolved bot's own real client.getUpdates — the running poller below
 * never passes anything else. It exists purely so this function can be
 * called directly with a hand-built batch of Update objects for real
 * verification (see prompt 0135/0138's own archives), without needing an
 * actual incoming Telegram message to drive it or touching the real
 * long-poll offset while the live poller loop is also running.
 *
 * Prompt 0140 — `isInjected` (true whenever a caller passes its own
 * `fetchUpdatesFn`) is what makes that last guarantee actually true: it
 * used to be aspirational only ("without... touching the real long-poll
 * offset") but the code called the real `setOffset()` unconditionally
 * regardless of where the updates came from. A real incident traced
 * directly to this: prompt 0139's own verification script injected a
 * synthetic update_id deliberately inflated by +3,000,000 (specifically to
 * avoid colliding with real traffic) and this function still persisted
 * that inflated value as the bot's real long-poll cursor — corrupting it
 * and causing the real poller to stop seeing genuinely new incoming
 * updates until manually repaired (see this prompt's own incident
 * archive for the full reconstruction and repair). 0140 stopped this
 * function from ever advancing the persisted offset for an injected call.
 *
 * Prompt 0141 (Revision) — 0140's own fix turned out to be one instance of
 * a whole CLASS of bug, not the complete fix: the exact same synthetic
 * update_id technique corrupted OTHER real state twice more after 0140
 * shipped — the trial bot's own offset, identically, discovered while
 * investigating 0139's incident (left unrepaired at the time since it had
 * zero pending real backlog); and, during this prompt's own live welcome-
 * copy verification, one real subscriber's own `last_welcomed_update_id`
 * dedup marker got inflated by an injected call's `recordWelcomeSent()`,
 * caught and manually repaired afterward. Both were the same root cause
 * 0140 only partially closed: an injected call still ran `upsertFromStart`
 * (a real subscriber row write) and `recordWelcomeSent` (a real dedup-
 * marker write) unconditionally, exactly like it still ran the real
 * `setOffset` before 0140.
 *
 * Closed for good, the same way 0140 closed it for the offset: an injected
 * call is now a true dry run for every real write in this function, not
 * just one of them. Instead of `upsertFromStart()` (INSERT/UPDATE), an
 * injected call does a plain READ (`findSubscriberByChatId`) to learn the
 * subscriber's REAL current dedup state — falling back to an in-memory-
 * only shape (`last_welcomed_update_id: null`) if this chat has never
 * actually /start-ed for real, so a first-time synthetic chat id still
 * exercises the send path without ever inserting a fabricated row.
 * `recordWelcomeSent()` is skipped entirely for an injected call, same
 * `if (!isInjected)` shape `setOffset()` already used. The actual Telegram
 * send (`sendWelcomeMessage`) still happens for real either way — that's
 * the entire point of injecting: proving a real send occurs — only the
 * bookkeeping that would affect a FUTURE real poll's own behavior is ever
 * skipped.
 */
export async function pollOnce(botId, fetchUpdatesFn) {
  const client = getTelegramClient(botId);
  const isInjected = Boolean(fetchUpdatesFn);
  const fetchFn = fetchUpdatesFn || ((offset, timeoutSeconds) => client.getUpdates(offset, timeoutSeconds));

  const offset = getOffset(botId);
  const updates = await fetchFn(offset, config.telegram.pollTimeoutSeconds);
  if (updates.length === 0) return;

  let maxUpdateId = offset - 1;
  for (const update of updates) {
    maxUpdateId = Math.max(maxUpdateId, update.update_id);
    const message = update.message;
    if (message?.text?.startsWith('/start')) {
      const chatId = String(message.chat.id);
      // Prompt 0233 — the /start deep-link payload ("start parameter"),
      // used for ad attribution. parseStartPayload() is strict (see
      // startCommands.js): anything outside the exact /start shape yields
      // null, and the welcome behavior below is unchanged either way —
      // only upsertFromStart's INSERT branch ever consumes this, so an
      // existing subscriber's source is never rewritten.
      const source = parseStartPayload(message.text);
      // Prompt 0141 (Revision) — a dry-run READ for an injected call,
      // never the real upsert; see this function's own header comment
      // above for the full incident history this closes.
      const subscriber = isInjected
        ? findSubscriberByChatId(botId, chatId) ?? { id: null, chat_id: chatId, last_welcomed_update_id: null }
        : upsertFromStart({
            botId,
            chatId,
            username: message.from?.username,
            firstName: message.from?.first_name,
            source
          });
      // Prompt 0135 — the welcome reply. Deduplicated per real update_id
      // (shouldSendWelcome), not a permanent per-chat "ever welcomed" flag
      // — see that function's own comment for why. Wrapped in its own
      // try/catch, deliberately never allowed to propagate: a failed send
      // (bad chat id, bot blocked, a transient network error, ...) must
      // never abort this batch or hold back setOffset() below, or the
      // poller would get stuck retrying the same batch forever over one
      // unreachable chat.
      if (shouldSendWelcome(subscriber.last_welcomed_update_id, update.update_id)) {
        try {
          const result = await sendWelcomeMessage(subscriber.chat_id, botId);
          // Never persisted for an injected call — see this function's
          // own header comment (the dedup marker is exactly the second
          // real-state field the incident history above traces to).
          if (!isInjected) {
            recordWelcomeSent(subscriber.id, update.update_id);
          }
          // Prompt 0140 — the one line that used to not exist at all: a
          // completed send was previously silent, which is exactly what
          // made this prompt's own real incident impossible to reconstruct
          // from logs alone (see the incident archive).
          console.log(`[telegram] welcome sent: bot=${botId} chat=${subscriber.chat_id} message_id=${result.message_id} path=welcome${isInjected ? ' (injected — no state persisted)' : ''}`);
        } catch (err) {
          console.error(`[telegram] welcome send failed for bot '${botId}' chat ${subscriber.chat_id}:`, err.message);
        }
      }
    } else if (isHelpCommand(message?.text)) {
      // Prompt 0233 — /help gets one plain text reply, no buttons, no
      // state written anywhere (so the injected dry-run path needs no
      // special casing here: there is nothing to persist either way).
      // Same never-propagate contract as the welcome send above — a
      // failed /help reply must never abort the batch or hold back
      // setOffset() below.
      const chatId = String(message.chat.id);
      try {
        const result = await client.sendMessage(chatId, HELP_MESSAGE_TEXT);
        console.log(`[telegram] help sent: bot=${botId} chat=${chatId} message_id=${result.message_id}${isInjected ? ' (injected)' : ''}`);
      } catch (err) {
        console.error(`[telegram] help send failed for bot '${botId}' chat ${chatId}:`, err.message);
      }
    } else if (isUnknownPrivateMessage(update)) {
      // Prompt 0236 — every OTHER private human message (free text, media
      // with no text, unknown commands) gets ONE polite auto reply, through
      // the exact same sendMessage shape as /help above (own try/catch,
      // never holds back setOffset). Dedup: each update is processed once
      // by the offset mechanics, and the per chat window below also covers
      // a crash-reprocess of the same batch.
      const chatId = String(message.chat.id);
      const replyKey = `${botId}:${chatId}`;
      if (Date.now() - (lastAutoReplyAt.get(replyKey) ?? 0) >= AUTO_REPLY_WINDOW_MS) {
        try {
          const result = await client.sendMessage(chatId, AUTO_REPLY_TEXT);
          // Stamped only on SUCCESS — a failed send never burns the window.
          lastAutoReplyAt.set(replyKey, Date.now());
          if (lastAutoReplyAt.size > 50000) {
            const cutoff = Date.now() - AUTO_REPLY_WINDOW_MS;
            for (const [key, at] of lastAutoReplyAt) {
              if (at < cutoff) lastAutoReplyAt.delete(key);
            }
          }
          // One line, no names and no message content — only ids.
          console.log(`[telegram] auto reply sent: bot=${botId} chat=${chatId} message_id=${result.message_id}${isInjected ? ' (injected)' : ''}`);
        } catch (err) {
          console.error(`[telegram] auto reply failed for bot '${botId}' chat ${chatId}:`, err.message);
        }
      }
    }
    // A user blocking the bot could also be detected here via my_chat_member
    // updates, but is handled defensively at send time instead (a 403 from
    // sendMessage/sendPhoto) — see worker.js. That covers the case
    // regardless of whether this update type is delivered/parsed correctly.
  }

  // Persisted *after* every upsert in the batch succeeds — a crash mid-batch
  // means the same updates get reprocessed on restart, which is safe since
  // upsertFromStart is idempotent, rather than silently dropping a /start.
  // Never persisted for an injected (verification-only) call — see
  // isInjected's own comment above.
  if (!isInjected) {
    setOffset(botId, maxUpdateId + 1);
  }
}

/**
 * Fire-and-forget: the returned promise only resolves after
 * stopTelegramPoller(botId) is called for this same bot id. A bot with no
 * token configured skips starting entirely (logged once, not fatal) — the
 * same "null = feature off" convention this file's single-bot predecessor
 * already used, just checked per bot now via getTelegramClient(botId).
 */
export async function startTelegramPoller(botId) {
  if (!getTelegramClient(botId)) {
    console.log(`[telegram] bot '${botId}' has no token configured — subscriber poller not started.`);
    return;
  }
  stoppedFlags.set(botId, false);
  console.log(`[telegram] subscriber poller started for bot '${botId}'.`);
  while (!stoppedFlags.get(botId)) {
    try {
      await pollOnce(botId);
    } catch (err) {
      console.error(`[telegram] poller error for bot '${botId}', retrying in 5s:`, err.message);
      await sleep(5000);
    }
  }
}

export function stopTelegramPoller(botId) {
  stoppedFlags.set(botId, true);
}
