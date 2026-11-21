#!/usr/bin/env node
/**
 * Prompt 0233 — captures ONE real /start-with-payload Telegram Update from
 * the TRIAL bot and archives it (names redacted) as the test fixture
 * `prompt/evidence/0233-telegram-ads-test/start-with-payload.json`, so the
 * attribution tests run against a real Update shape, never a hand-invented
 * one.
 *
 * Usage (owner steps):
 *   1. Make sure NO local backend is running (one-backend rule — a live
 *      trial-bot poller would consume the /start before this script sees
 *      it).
 *   2. Send "/start ads_2026_10_a" to the TRIAL bot (@PercobaanPanel_bot)
 *      from your own Telegram account.
 *   3. From backend/: node scripts/fetchStartFixture.js
 *
 * Token: FIXTURE_BOT_TOKEN from the terminal environment when set (a
 * TEMPORARY bot made just for this capture — needed because the TRIAL
 * bot's getUpdates queue came back empty from the laptop that day; the
 * 0233 guess "it is polled by the VM backend" was later REFUTED by the
 * VM's own startup log, and the real consumer was never proven),
 * otherwise the trial bot's own token
 * (config.telegram.bots.test.botToken, i.e. TELEGRAM_BOT_TOKEN_TEST from
 * backend/.env). Never the official bot's, which does not exist on the
 * laptop anyway (deploy lesson 9). The token is never printed and never
 * written to any file. TELEGRAM_DISABLED=1 is honored for the fallback
 * path (config nulls every token); FIXTURE_BOT_TOKEN, being an explicit
 * per-run terminal value, wins when present.
 *
 * This getUpdates call passes NO offset, which never confirms anything to
 * Telegram — the same /start stays pending, so the next real trial-bot
 * poller run will still process it normally (one welcome to the owner's
 * own chat; harmless, trial bot). Redaction: first_name/last_name/username
 * on `message.from` and `message.chat` become "redacted"; the chat id is
 * kept on purpose (trial bot, the owner's own chat).
 *
 * GROUP MODE (prompt 0250): `node scripts/fetchStartFixture.js --group`
 * captures the latest real /start sent inside a GROUP and inside a
 * SUPERGROUP and writes them to
 * `prompt/evidence/0250-group-start/start-group.json` and
 * `start-supergroup.json` (whichever chat types are present in the queue;
 * each run rewrites both when both are there, since a no-offset getUpdates
 * keeps returning the same pending updates). Differences from the default
 * mode, all deliberate:
 *  - the token comes ONLY from FIXTURE_BOT_TOKEN — there is NO fallback to
 *    any configured bot, so this mode can never read the trial bot's or
 *    any real bot's queue by accident;
 *  - redaction is DEEP (startFixtureHelpers.js's redactDeep): every
 *    first_name / last_name / username / title at any depth becomes
 *    "redacted" — chat.title and the sender's names included;
 *  - the fixture is refused (nothing written) if its serialized form
 *    contains anything shaped like a bot token.
 * `--out <dir>` (group mode only) redirects the two files to another
 * directory — for dry runs against a local fake API, never needed by the
 * owner's real capture.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config/env.js';
import { START_PAYLOAD_PATTERN } from '../src/telegram/startCommands.js';
import { redactDeep, pickGroupStartUpdates, GROUP_FIXTURE_FILES, BOT_TOKEN_SHAPE } from './startFixtureHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../../prompt/evidence/0233-telegram-ads-test');
const FIXTURE_PATH = path.join(FIXTURE_DIR, 'start-with-payload.json');
const GROUP_FIXTURE_DIR = path.resolve(__dirname, '../../prompt/evidence/0250-group-start');

function redact(obj) {
  if (!obj) return obj;
  const out = { ...obj };
  for (const key of ['first_name', 'last_name', 'username']) {
    if (key in out) out[key] = 'redacted';
  }
  return out;
}

async function main() {
  const fixtureToken = process.env.FIXTURE_BOT_TOKEN;
  const token = fixtureToken || config.telegram.bots.test.botToken;
  if (!token) {
    console.error(
      'No token available: set FIXTURE_BOT_TOKEN in this terminal, or configure TELEGRAM_BOT_TOKEN_TEST (TELEGRAM_DISABLED must be off for the fallback). Nothing fetched.'
    );
    process.exit(1);
  }
  console.log(`Using ${fixtureToken ? 'FIXTURE_BOT_TOKEN (temporary fixture bot)' : 'the trial bot token from backend/.env'}.`);

  // Diagnostic (prompt 0233): prove WHICH bot this token belongs to before
  // reading its queue — username only, never the token.
  const meRes = await fetch(`${config.telegram.apiRoot}/bot${token}/getMe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15000)
  });
  const me = await meRes.json();
  if (!me.ok) {
    console.error(`Telegram getMe failed: ${me.error_code} ${me.description}`);
    process.exit(1);
  }
  console.log(`Bot: @${me.result.username}`);

  // No offset: read-only, confirms nothing — see this file's header.
  // allowed_updates ['message'] INCLUDES message updates (it excludes
  // nothing this script needs); printed verbatim below for transparency.
  const getUpdatesParams = { timeout: 0, allowed_updates: ['message'] };
  console.log(`getUpdates params: ${JSON.stringify(getUpdatesParams)}`);
  const res = await fetch(`${config.telegram.apiRoot}/bot${token}/getUpdates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(getUpdatesParams),
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`Telegram getUpdates failed: ${data.error_code} ${data.description}`);
    process.exit(1);
  }

  // Diagnostic: the raw queue as received — update_id + message text only,
  // never names/usernames.
  console.log(`Raw updates received: ${data.result.length}`);
  for (const u of data.result) {
    console.log(`  update_id=${u.update_id} text=${JSON.stringify(u.message?.text ?? null)}`);
  }

  const candidates = data.result.filter((u) => {
    const match = u.message?.text ? START_PAYLOAD_PATTERN.exec(u.message.text) : null;
    return Boolean(match?.[1]);
  });
  if (candidates.length === 0) {
    console.error(
      `No pending /start-with-payload update found (${data.result.length} pending updates total). ` +
        'Send "/start ads_2026_10_a" to the bot this token belongs to first (and make sure nothing else is polling it), then rerun.'
    );
    process.exit(1);
  }

  const latest = candidates.reduce((a, b) => (b.update_id > a.update_id ? b : a));
  const fixture = {
    ...latest,
    message: {
      ...latest.message,
      from: redact(latest.message.from),
      chat: redact(latest.message.chat)
    }
  };

  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + '\n');
  const payload = START_PAYLOAD_PATTERN.exec(fixture.message.text)[1];
  console.log(`Saved update_id=${fixture.update_id} payload=${payload} to ${FIXTURE_PATH}`);
}

async function callBot(token, method, params) {
  const res = await fetch(`${config.telegram.apiRoot}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`Telegram ${method} failed: ${data.error_code} ${data.description}`);
    process.exit(1);
  }
  return data.result;
}

/** Prompt 0250 — see GROUP MODE in this file's header. */
async function mainGroup(outDir) {
  const token = process.env.FIXTURE_BOT_TOKEN;
  if (!token) {
    console.error('Group mode needs FIXTURE_BOT_TOKEN set in this terminal (a temporary bot). There is no fallback to any configured bot. Nothing fetched.');
    process.exit(1);
  }
  console.log('Using FIXTURE_BOT_TOKEN (temporary fixture bot). Group mode.');

  const me = await callBot(token, 'getMe', {});
  console.log(`Bot: @${me.username}`);

  // No offset: read-only, confirms nothing.
  const getUpdatesParams = { timeout: 0, allowed_updates: ['message'] };
  console.log(`getUpdates params: ${JSON.stringify(getUpdatesParams)}`);
  const updates = await callBot(token, 'getUpdates', getUpdatesParams);

  // Diagnostic: update_id, chat type, message text and which service flag
  // is present — never a name, a title or an id of any chat or person.
  console.log(`Raw updates received: ${updates.length}`);
  for (const u of updates) {
    const m = u.message;
    const service = m
      ? ['migrate_to_chat_id', 'migrate_from_chat_id', 'new_chat_members', 'group_chat_created', 'supergroup_chat_created'].filter((k) => k in m)
      : [];
    console.log(
      `  update_id=${u.update_id} chat.type=${m?.chat?.type ?? null} text=${JSON.stringify(m?.text ?? null)}${service.length ? ` service=${service.join(',')}` : ''}`
    );
  }

  const picked = pickGroupStartUpdates(updates);
  let written = 0;
  for (const [type, fileName] of Object.entries(GROUP_FIXTURE_FILES)) {
    const update = picked[type];
    if (!update) {
      console.log(`chat.type=${type}: no pending /start found, ${fileName} NOT written.`);
      continue;
    }
    const serialized = JSON.stringify(redactDeep(update), null, 2) + '\n';
    if (BOT_TOKEN_SHAPE.test(serialized)) {
      console.error(`chat.type=${type}: the update contains something shaped like a bot token. ${fileName} NOT written.`);
      process.exit(1);
    }
    mkdirSync(outDir, { recursive: true });
    const target = path.join(outDir, fileName);
    writeFileSync(target, serialized);
    written += 1;
    console.log(`chat.type=${type}: saved update_id=${update.update_id} text=${JSON.stringify(update.message.text)} to ${target}`);
  }
  if (written === 0) {
    console.error('No /start from a group or supergroup is pending. Send /start (and /start@<this bot username>) inside the test group first, then rerun.');
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const groupMode = args.includes('--group');
const outIndex = args.indexOf('--out');
if (outIndex !== -1 && (!groupMode || !args[outIndex + 1])) {
  console.error('--out <dir> is only valid together with --group and needs a directory.');
  process.exit(1);
}
const entry = groupMode ? () => mainGroup(outIndex !== -1 ? path.resolve(args[outIndex + 1]) : GROUP_FIXTURE_DIR) : main;

entry().catch((err) => {
  console.error('fetchStartFixture failed:', err.message);
  process.exit(1);
});
