# Fluxio Admin Backend

Express + SQLite API backing the admin panel (`admin/`). Slice 1 shipped admin auth (session-based) and Announcements: protected CRUD plus a public read-only endpoint the wallet apps will eventually poll. Slice 2 added Telegram broadcast: send a message to a single channel or to every subscriber who has `/start`-ed the bot, via a durable queue + throttled worker. Slice 3 added Analytics: wallet apps beacon an anonymous `WALLET_CREATED` event, and the admin panel gets an aggregate-only dashboard. Slice 4 added version control: admins set the latest/minimum-supported app version per platform, and wallet apps check in against a public endpoint to learn whether they must (or merely can) update. Slice 5 activates role-based access (superadmin/editor, real for the first time) and adds an audit log. Slice 6 extends Telegram broadcast with one-time scheduled sends and cancellation before they go out.

> **Node version:** requires **Node ≥ 22.5** — this uses Node's built-in `node:sqlite` module (see "Database" below), not the `better-sqlite3` package.

## What this is (and isn't)

Six slices in: foundation + auth + Announcements (Slice 1), Telegram broadcast (Slice 2), Analytics (Slice 3), version control (Slice 4), roles/permissions/audit log (Slice 5), scheduled Telegram broadcasts + cancel (Slice 6). It is not the full backend the `wallet ecosystem/README.md` diagram envisions (blockchain data, broadcast delivery to Discord/email/push/etc. — Telegram is the one channel actually built), and this service holds **no wallet secrets of any kind** — no private keys, no seed phrases, no wallet-address-to-identity mapping. Announcements and Telegram broadcasts are both one-way broadcast content only; Telegram subscriber rows and analytics events both store only opaque, non-wallet identifiers (Telegram chat id/username/first name; a random client-generated `walletId` never mapped to any on-chain address) — never anything that connects to a real wallet's actual keys or funds. The version-check endpoint doesn't even store anything wallet-related — it doesn't persist the request at all. The audit log records admin actions only — logins, publishes, sends, version/role changes, self-service password changes (`admin.password_changed`, never the password or hash itself) — never anything about wallet users.

## Getting started

```bash
cd backend
cp .env.example .env      # fill in real values, see table below
pnpm install               # from the repo root also works (workspace package)
pnpm create-admin -- --email=you@example.com --password=at-least-8-chars
pnpm dev                   # nodemon src/server.js, http://localhost:4000
```

Migrations run automatically on boot (`runMigrations()` in `server.js`), against a fresh SQLite file if one doesn't exist yet — nothing to run by hand.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | `nodemon src/server.js` — auto-restarts on file change |
| `pnpm start` | `node src/server.js` — no watcher, for production |
| `pnpm create-admin -- --email=... --password=... [--role=superadmin\|editor]` | Creates an admin account. The **only** way to create one — there is no public signup endpoint, by design |

## Environment variables (`.env`)

| Variable | Meaning | Example |
|---|---|---|
| `PORT` | HTTP port | `4000` |
| `NODE_ENV` | `development` or `production` — forces the session cookie's `Secure` flag on in production | `development` |
| `DATABASE_PATH` | Path to the SQLite file, relative to `backend/` | `./data/fluxio-admin.db` |
| `ADMIN_ORIGIN` | Origin the admin frontend is served from (CORS allowlist) | `http://localhost:4174` |
| `SESSION_COOKIE_NAME` | Cookie name for the session token | `fluxio_admin_session` |
| `SESSION_TTL_DAYS` | Session lifetime | `7` |
| `COOKIE_SECURE` | Force `Secure` on the cookie outside production (e.g. testing behind HTTPS) | `false` |
| `BCRYPT_COST` | bcrypt work factor for password hashing | `12` |
| `TELEGRAM_BOT_TOKEN_TEST` | Bot token from [@BotFather](https://t.me/BotFather) for the 'test' bot (the dual-bot setup's own trial account). Leave empty for local dev without a real bot — see "Telegram broadcast" below | *(empty)* |
| `TELEGRAM_BOT_TOKEN_OFFICIAL` | Same, for the 'official' bot — no legacy fallback exists for this one | *(empty)* |
| `TELEGRAM_BOT_TOKEN` | Deprecated legacy single-bot token, kept only as a fallback for a pre-dual-bot deployment that hasn't migrated to the two keys above yet. Leave empty on any fresh install | *(empty)* |
| `TELEGRAM_POLL_TIMEOUT_SECONDS` | How long each `getUpdates` long-poll call waits for new updates | `25` |
| `TELEGRAM_WORKER_BATCH_SIZE` | Max messages sent per broadcast-worker tick | `20` |
| `TELEGRAM_WORKER_TICK_MS` | Milliseconds between broadcast-worker ticks | `1000` |
| `TELEGRAM_STORAGE_CHAT_ID_TEST` | Chat ID the 'test' bot uses as private storage when uploading broadcast/welcome media (Telegram Bot API has no direct "upload and get back a permanent URL" call, so this project re-uploads to a chat it controls first) | *(empty)* |
| `TELEGRAM_STORAGE_CHAT_ID_OFFICIAL` | Same, for the 'official' bot | *(empty)* |
| `TELEGRAM_STORAGE_CHAT_ID` | Deprecated legacy fallback, same relationship to the two keys above as `TELEGRAM_BOT_TOKEN` has to `TELEGRAM_BOT_TOKEN_TEST`/`_OFFICIAL`. Leave empty on any fresh install | *(empty)* |
| `RECURRING_INTERVAL_MS` | Overrides the real 1-hour recurring-broadcast interval for local testing only. **Leave empty in production** — the default only applies when this is unset | *(empty)* |

The SQLite file itself (`backend/data/*.db` and its `-wal`/`-shm` companions) is gitignored — never commit it, it's a local dev artifact.

## Auth design

- Passwords are hashed with `bcryptjs` (pure JS, no native build step — see below for why that matters here specifically).
- Sessions are **opaque, server-side, DB-backed** — not JWTs. A random 32-byte token goes in an `httpOnly` cookie; only its SHA-256 hash is stored in `admin_sessions`. This means a session can be revoked instantly (delete the row) and every request re-reads the admin's *current* role from the database, rather than trusting a JWT's claims frozen at issuance.
- `role` on `admins` is `superadmin` or `editor`. `requireRole(...)` (`src/middleware/requireRole.js`) sat unused through Slices 1–4; Slice 5 wires it into `/admin/versions`, `/admin/admins`, `/admin/audit-logs`. Because sessions re-read the admin's role from the database on every request (not a JWT claim frozen at login), a role change via `PATCH /admin/admins/:id` takes effect on that admin's *very next request* — no re-login needed, and no way to keep using elevated access after being demoted.
- No admin account can be created without running `scripts/createAdmin.js` — there's no hardcoded credential anywhere in this codebase, and no self-serve `/admin/signup`. `PATCH /admin/admins/:id` (Slice 5) can change an *existing* admin's role or active status, but still can't create or delete one — see the "Roles, permissions & audit log" section below for the exact scope.

## The public Announcements endpoint — a standing privacy constraint

`GET /api/announcements` is intentionally unauthenticated (the wallet apps need to read it without a login), and it is a **hard constraint, not just current behavior**, that this route:

- Never reads or persists `req.ip`, `req.headers['user-agent']`, or any other value that could identify or fingerprint a caller.
- Has no request-logging middleware applied to it (see `src/app.js` — the public router is mounted without any logger).
- Returns only `published` announcements currently inside their schedule window (`starts_at`/`ends_at`), and only public-safe fields (never `created_by` or any other internal column).

If operational request-volume monitoring is ever added to this route, it must be aggregate-only (a counter), never a per-request log line with any caller-identifying value. This mirrors the wallet's own non-custodial stance: Fluxio never needs to know who is reading its announcements.

## Database: SQLite now, Postgres later

No ORM — plain parameterized SQL, with a ~45-line hand-written migration runner (`src/db/migrate.js`) applying numbered files from `src/db/migrations/`. This matches how the rest of this repo's real code (`packages/crypto`, `packages/services`) is built: small, explicit, dependency-light modules, not a generated-client/ORM layer.

**Driver: Node's built-in `node:sqlite` (`DatabaseSync`), not the `better-sqlite3` package.** The original plan called for `better-sqlite3`, but it ships no prebuilt binary for every Node/platform combination and falls back to compiling from source via `node-gyp`, which needs Python plus a C++ toolchain — not something a plain dev machine necessarily has. `node:sqlite` ships with Node itself (stable since Node 22.5), needs no native build step and no extra dependency, and its API is close enough to `better-sqlite3`'s (`db.prepare(sql).get/all/run(params)`, `?`/`@name` placeholders, a `{changes, lastInsertRowid}` run() result) that the repository layer and migration runner needed only trivial changes — mainly hand-rolling `BEGIN`/`COMMIT`/`ROLLBACK` in `migrate.js` since `DatabaseSync` has no `db.transaction(fn)` convenience wrapper. It's still labeled "experimental" in Node's own docs (one warning line on boot), but is the same synchronous, file-backed, real SQLite underneath.

Two schema choices make a later Postgres migration close to mechanical regardless of which SQLite driver got us there:

1. **Primary keys are `TEXT` UUIDs** (`crypto.randomUUID()`, generated in application code) — no `AUTOINCREMENT`/`SERIAL` divergence to reconcile.
2. **Timestamps are `TEXT` ISO-8601 strings** (SQLite has no native datetime type) — these cast cleanly onto Postgres `TIMESTAMPTZ`.

When the time comes: swap the `node:sqlite` calls in `src/db/client.js` for `pg`, port the `.sql` migration files (mostly syntax-identical — mainly tightening `TEXT` to `VARCHAR`/`TIMESTAMPTZ`/`BOOLEAN` where it matters), and swap the repository layer's `db.prepare(...).get/all/run` calls for `pg`'s query interface. No schema redesign needed.

## Telegram broadcast (Slice 2)

`src/telegram/` holds three pieces, all reachable from `server.js` after `runMigrations()` — both start automatically and both **skip cleanly (logged once, not fatal) when `TELEGRAM_BOT_TOKEN` is unset**, so local dev never requires a real bot:

- **`client.js`** — a hand-rolled Telegram Bot API client on native `fetch` (`getMe`, `sendMessage`, `sendPhoto`, `getUpdates`). No `node-telegram-bot-api`/`telegraf` dependency: Node ≥22.5 already has global `fetch`, only 4 plain-HTTPS-JSON methods are needed, and both libraries bring their own polling/session abstractions that would fight this backend's own SQLite-backed queue design rather than help it. Same "skip a dependency where a built-in suffices" reasoning as `bcryptjs`/`node:sqlite` elsewhere in this backend.
- **`poller.js`** — subscriber intake via **long-polling**, not a webhook (a webhook needs a public HTTPS URL, which this dev setup has no tunnel/ngrok infra for). A self-rescheduling loop (not `setInterval` — `getUpdates` itself blocks for up to the poll timeout) reads `/start` messages, upserts the sender into `telegram_subscribers`, and persists the Telegram update offset in `telegram_poll_state` so a restart doesn't reprocess or miss anything.
- **`worker.js`** — the throttled queue drain. A `telegram_broadcast_recipients` row *is* a queued job (`pending`/`sent`/`failed`) — there's no Redis/Bull anywhere in this repo, so a DB-table queue drained by a single in-process worker tick is the natural fit at this scale. Every second, up to `TELEGRAM_WORKER_BATCH_SIZE` pending rows are sent **sequentially** (never `Promise.all`), capping throughput comfortably under Telegram's ~30 msg/sec limit. A 403 (bot blocked by that chat) deactivates the subscriber so future broadcasts skip them automatically; a 429 pauses the whole worker for Telegram's own `retry_after` rather than hammering the API; any other per-recipient failure is recorded on that row without aborting the rest of the batch.

**Channel-targeted broadcasts** (a single chat/channel ID typed into the composer) send synchronously inline — one message, no rate-limit concern, no recipient-table rows. **Subscriber-targeted broadcasts** snapshot every currently-active subscriber into `telegram_broadcast_recipients` at creation time and return immediately (`status: 'queued'`); the worker does the rest.

Media is an optional URL field only (Telegram's `sendPhoto` accepts a public URL directly) — no file upload/storage in this slice. Messages are sent as plain text, deliberately without `parse_mode`, to avoid a class of 400 errors from unescaped Markdown/HTML in admin-authored text.

### Manual end-to-end checklist (needs a real `TELEGRAM_BOT_TOKEN`)

The automated verification only covers the structural paths (auth, validation, the zero-subscriber and invalid-token cases) — these steps need an actual bot from [@BotFather](https://t.me/BotFather):

1. Set the token, restart, confirm `[telegram] subscriber poller started.` / `[telegram] broadcast worker started.` in the logs.
2. `/start` the bot from a personal Telegram account — within `TELEGRAM_POLL_TIMEOUT_SECONDS`, confirm a new row in `telegram_subscribers`.
3. Restart the backend — confirm the poller resumes from the persisted offset (no duplicate reprocessing of the same `/start`).
4. Channel-targeted send (bot must already be an admin of that channel) — message arrives, broadcast status `completed`.
5. Subscriber-targeted send with ≥2 active subscribers — both receive it, `sent_count` matches, History page reflects it.
6. Block the bot from a test account, send again — that recipient ends up `failed`, the subscriber's `is_active` flips to 0, and the next broadcast's subscriber count excludes them automatically.

## Scheduled Telegram broadcasts + cancel (Slice 6)

Extends Slice 2's broadcast with a second way to trigger the same send pipeline: later, at an admin-chosen time, instead of immediately. One-time schedule only — no recurrence.

- **Schema** (`src/db/migrations/0008_extend_telegram_broadcasts_scheduling.sql`) — widens `telegram_broadcasts.status`'s `CHECK` to add `'scheduled'`/`'canceled'` and adds a nullable `scheduled_at TEXT` (UTC ISO-8601, generated in JS like every other timestamp in this schema; `NULL` still means "send now", today's unchanged behavior). SQLite can't `ALTER` a `CHECK` constraint in place, so this migration recreates the table (create-new/copy/drop-old/rename) — see the next point for why that needed a small migration-runner change, not just a bigger SQL file.
- **`db/migrate.js`'s `manages-own-transaction` opt-in** — recreating a table referenced by a foreign key (`telegram_broadcast_recipients.broadcast_id`) needs `PRAGMA foreign_keys=OFF` around the `DROP TABLE` step, but that pragma is a documented no-op while a transaction is already open, and every migration normally runs inside one `BEGIN`/`COMMIT` wrapper. A migration file whose content starts with the marker comment `-- fluxio:manual-transaction` is instead executed as a single `db.exec(sql)` with no outer wrapper, so its own embedded `PRAGMA foreign_keys=OFF; BEGIN; ...; COMMIT; PRAGMA foreign_keys=ON;` actually takes effect. Every other migration file is unaffected — they don't start with the marker, so they go through the same default-wrapped path as before.
- **Timezone handling** reuses `admin/src/utils/formatDate.js`'s existing `toDatetimeLocalValue`/`fromDatetimeLocalValue` helpers (built for Announcements' `startsAt`/`endsAt` in Slice 1) — the admin picks a time in their own local timezone, it's converted to UTC before being sent to the API, and re-rendered in local time on display. No new utility code.
- **Worker/scheduler** — `src/telegram/worker.js`'s `tick()` runs a new `activateDueScheduled()` step first, every tick: `SELECT * FROM telegram_broadcasts WHERE status='scheduled' AND scheduled_at <= now`. That plain `<=` comparison is catch-up-safe by construction — if the server was down when a schedule passed, it's still "due" (however overdue) the moment the next tick runs after restart, so nothing is silently skipped. A subscriber-targeted broadcast's recipient list is snapshotted **at activation time**, not at compose time — more accurate to who's actually reachable when the message goes out.
- **Race safety** — both the worker's activation step and the new cancel endpoint call the same repository function, `transitionFromScheduled(id, newStatus)`: an atomic `UPDATE telegram_broadcasts SET status=? WHERE id=? AND status='scheduled'`, returning whether it actually changed a row. Whichever caller reaches a given broadcast first legitimately wins; the other's update matches zero rows and becomes a no-op instead of overwriting. This closes two real races: a cancel request arriving mid-`await` during a channel-target send, and a cancel request for a broadcast still further down a multi-broadcast activation batch.
- **Cancel endpoint** — `POST /admin/broadcast/telegram/:id/cancel` (`requireAuth` only, same access as the rest of `/admin/broadcast/telegram`). `404` if the broadcast doesn't exist; `409 CANNOT_CANCEL` (with the broadcast's actual current status in the message) if `transitionFromScheduled` reports it wasn't still `'scheduled'` — never trusts anything the client asserted about status. Logs `broadcast.telegram.cancel` on success; the scheduled-create path logs its own `broadcast.telegram.schedule`, distinct from the existing `broadcast.telegram.send`.
- **`create` endpoint** — `scheduledAt` is validated as an ISO-8601 string strictly in the future (server-side authoritative check; the frontend's `datetime-local` `min` attribute is just a UX nudge). When present, the broadcast is created with `status:'scheduled'` and no send is attempted — the worker picks it up later.

### Manual end-to-end checklist for scheduling (needs a real `TELEGRAM_BOT_TOKEN` to see an actual send; the schedule/cancel/catch-up mechanics themselves don't)

1. Schedule a broadcast a minute or two out — confirm it sits as `scheduled`, nothing sent.
2. Cancel it before it falls due — confirm status `canceled`, and that it's still untouched once its original time passes.
3. Let a different scheduled broadcast fall due naturally — confirm it activates and sends (or, without a real bot token, that it transitions out of `scheduled` and records the expected failure).
4. Stop the backend before a scheduled time passes, restart it after — confirm the broadcast still activates on the first tick post-restart (catch-up), not silently skipped.
5. Try cancelling an already-`completed`/`sending` broadcast — `409 CANNOT_CANCEL` with the real current status.
6. Try scheduling a broadcast in the past — `400` rejected at the API.

## Analytics (Slice 3)

`POST /api/events` is the third unauthenticated public route (see `src/controllers/publicEventsController.js`) — wallet apps beacon lifecycle events here. This slice only accepts `WALLET_CREATED`; the `analytics_events` table's `event` column is deliberately **not** `CHECK`-constrained (unlike almost everything else in this schema) since more event types are expected in future slices — the known set is validated at the zod layer instead (`src/routes/publicEventsRoutes.js`), narrower than what the table itself allows.

- **Privacy, as a hard constraint**: `walletId` is a random ID the wallet app generates client-side. No table anywhere in this schema maps it to an on-chain address or public key, and no endpoint (admin or public) returns an individual event or `wallet_id` — every query in `src/db/repositories/analyticsEventsRepo.js` is a `COUNT(*)`/`GROUP BY`, never a row lookup by wallet.
- **Idempotency**: `UNIQUE(event, wallet_id)` + `INSERT ... ON CONFLICT DO NOTHING` — a retried beacon (network flakiness on the client) doesn't inflate the "new wallets per day" count. The endpoint always responds `202 { ok: true }` regardless of whether the row was actually new, so a caller can never use the response to probe dedup state.
- **Schema**: `analytics_events` (one row per event) plus `analytics_event_chains` (one row per chain in that event's `chains` array — normalized rather than JSON-in-a-column, so "most popular chain" is a plain indexed `GROUP BY`, no JSON1/`json_each()` dependency). `chain` is `CHECK`-constrained to the 4 values in `packages/constants/networks.js`'s `NETWORK_KEYS` — this backend now depends on `@fluxio/constants` (its first `@fluxio/*` workspace dependency) specifically so the zod validation layer reuses that single source of truth instead of re-declaring the 4 chain keys.
- **Timestamp normalization**: the payload's `timestamp` is parsed and re-serialized via `new Date(timestamp).toISOString()` before storage (`occurred_at`) — not stored as whatever loose-but-Date.parse-able string the client sent. The day-bucketing query (`substr(occurred_at, 1, 10)`) assumes that canonical shape.
- **No retention metric this slice** — `WALLET_CREATED` fires once per wallet, so there's no second data point to test "did this wallet come back" against. `GET /admin/analytics/summary` ships a new-wallets-per-day trend and an all-time total instead; real retention needs a second, recurring event type that doesn't exist yet.
- **CORS**: this is the route that forced a real fix. `src/app.js` used to apply one global `cors({ origin: config.adminOrigin, credentials: true })` to everything, which would have silently blocked a wallet app (a different origin entirely — `apps/web` on port 4173, or a `chrome-extension://` origin) from ever calling this endpoint. `/admin/*` now gets its own strict, credentialed CORS policy (session cookies need it); `/api/*` (both announcements and events) gets a separate, permissive, credential-less one — appropriate since neither route has a cookie or any other credential to protect, and it fixes the same latent gap on `/api/announcements` as a side effect.

## Version control (Slice 4)

`GET /api/version` is the fourth unauthenticated public route (see `src/controllers/publicVersionController.js`) — the strongest privacy stance of the four: it doesn't write to the database at all, just reads `app_versions` and computes a comparison. `PUT /admin/versions/:platform` (protected) is how admins set the config; `GET /admin/versions` always returns exactly 3 entries (`web`/`extension`/`mobile`), synthesizing nulls for a platform nobody's configured yet.

- **Comparison logic**: `src/utils/compareVersions.js` is a hand-rolled `X.Y.Z` comparator — no `semver` package (it only exists as a transitive lockfile entry elsewhere in this repo, never actually imported anywhere). `updateRequired` = `currentVersion < minSupportedVersion`; `updateAvailable` = `currentVersion < latestVersion`, computed independently (a required update is factually also an available one — the client UI decides which takes priority, force wins).
- **Safe default when unconfigured**: if an admin hasn't set up a platform yet, `GET /api/version` returns nulls and both booleans `false` — it never tells a wallet client to force-update just because nobody's configured that platform. This is a deliberate defensive choice, not an oversight.
- **Write-time sanity check**: `PUT /admin/versions/:platform`'s zod schema `.refine()`s that `latestVersion >= minSupportedVersion` — catches an admin accidentally swapping the two fields, which would otherwise force-update every single user on that platform.
- **No version-config history table** — a version config is either set or not, and an edit takes effect immediately; only the latest value is stored per platform. Slice 5's audit log does record *that* a `version.update` happened (who, when, the new values) — but that's a generic cross-feature action log, not a per-platform history/rollback feature for this one.
- **CORS**: no new work needed — `GET /api/version` inherits the open, credential-less `/api/*` CORS policy Slice 3 already set up.
- **Superadmin-only as of Slice 5** — a misconfigured minimum version can force-update or lock out every user on a platform, so `/admin/versions` now requires `requireRole('superadmin')`, not just any authenticated admin.

## Rich-text HTML in Announcements/Versions (prompt 0163) — a standing rendering contract

As of migrations `0021`/`0022`, `announcements.title`/`announcements.body` and `app_versions.update_message` can each independently be either `'plain'` (raw, unescaped text — every row created before this slice, and forever unless explicitly re-saved through the admin panel's rich-text editor) or `'html'` (pre-sanitized rich text). The admin API and both public endpoints (`GET /api/announcements`, `GET /api/version`) now expose the format alongside the content — `titleFormat`/`bodyFormat` on an announcement, `updateMessageFormat` on a version config — and this is a **required part of the response shape going forward, not an optional extra field a consumer can ignore**.

This is a **hard contract, not just current behavior**, for any current or future consumer of these two public endpoints:

- **The HTML whitelist is exactly `<b><i><u><s><a href="https://...">`** — see `src/utils/richHtml.js`'s `sanitizeRichHtml()`, the one function that produces every `'html'`-format value this backend ever stores or serves. Deliberately **no `<tg-emoji>`** — that tag is Telegram Bot API syntax for a premium custom emoji, and neither Announcements nor Versions are a Telegram concept, so it doesn't apply here (contrast with `src/telegram/formatting.js`'s `sanitizeTelegramHtml()`, which layers `<tg-emoji>` support on top of this same shared base specifically for broadcasts/Welcome).
- **A consumer MUST render an `'html'`-format value using that same restricted whitelist** — a full HTML/Markdown renderer, or `dangerouslySetInnerHTML`/raw `innerHTML` without independently sanitizing first, is exactly the kind of consumer this contract exists to rule out. See `admin/src/components/richTextParse.js`'s own hand-written recursive-descent parser for a safe reference implementation (never DOMParser/innerHTML — see that file's own header for why) — the same approach used to render this exact same HTML shape read-only elsewhere in this admin panel.
- **A `'plain'`-format value must never be interpreted as HTML/Markdown** — display it as literal text (whatever templating/escaping mechanism the consumer's own UI framework provides for plain text is sufficient; the point is that a legacy value's literal `<`/`>`/`&` characters must survive exactly as stored, never misread as markup).
- **Both public endpoints re-sanitize `'html'`-format values a second time, at read time**, not just once at write time (see `publicAnnouncementsController.js`/`publicVersionController.js`'s own `sanitizeForPublic()`) — the same defense-in-depth posture `sanitizeTelegramHtml()` already has for broadcasts. A consumer should still never skip its own sanitization on the assumption this backend's own defense is sufficient — treat every HTML string from any network response as untrusted, always.



`requireRole(...)` (`src/middleware/requireRole.js`) existed since Slice 1 but sat unused until now. Three routers require `requireRole('superadmin')` on top of `requireAuth`: `/admin/versions` (a misconfigured minimum version can lock out every user on a platform), `/admin/admins` (new this slice — managing other admins), and `/admin/audit-logs` (new — viewing what other admins have done is itself an oversight capability). Everything else (`/admin/announcements`, `/admin/broadcast/telegram`, `/admin/analytics`) is unchanged — any authenticated admin, either role.

- **Admin management is deliberately narrow**: `GET /admin/admins` lists every admin (including inactive ones, so a superadmin can find and reactivate one); `PATCH /admin/admins/:id` changes an *existing* admin's `role` and/or `isActive`. There is still no API way to create or delete an admin account — `scripts/createAdmin.js` remains the only path, unchanged from Slice 1. This was a deliberate scope choice, not an oversight — see the plan behind this slice if you want in-app admin creation added later.
- **Self-lockout guard**: `PATCH /admin/admins/:id` rejects `400 CANNOT_MODIFY_SELF` if `:id` is the acting admin's own id. This is the one structural protection needed against ending up with zero active superadmins — any superadmin acting on *someone else's* role necessarily leaves themselves untouched.
- **Audit log schema**: `audit_logs` (`src/db/migrations/0007_create_audit_logs.sql`) — `action` is free-text, not `CHECK`-constrained (same reasoning as `analytics_events.event`: more actions are likely later, and a `CHECK` would force a migration per addition). `metadata` is a JSON-in-TEXT column — a deliberate exception to this schema's usual "normalize, don't store JSON" rule, since audit-log context is genuinely heterogeneous per action type (a version change and a broadcast send share nothing to normalize against).
- **7 actions are logged**: `admin.login` (successful logins only — failed attempts are a different, brute-force-monitoring concern, out of scope here), `announcement.publish`, `broadcast.telegram.send` (logged at send-initiation, not at eventual per-recipient delivery), `broadcast.telegram.schedule` and `broadcast.telegram.cancel` (Slice 6), `version.update`, and `admin.updated` (a role/active-status change). Not logged: announcement create/edit/delete/unpublish, logout, or anything else — kept to what "aksi penting" (significant actions) actually implies, not every mutation in the system.
- **Audit logging never blocks the action it's recording**: `recordAuditLog()` (`src/db/repositories/auditLogsRepo.js`) catches its own errors internally and only `console.error`s — a logging failure must never prevent a legitimate login/publish/send/update from succeeding.
- **`GET /admin/audit-logs`** joins `admins` to include `admin_email` in every row (`db/repositories/auditLogsRepo.js`'s `listAuditLogs`) — "who" is the entire point of an audit log, so this resolves it server-side rather than leaving a raw `admin_id` for the frontend to cross-reference (unlike `announcements.created_by`, which nothing currently displays). Supports `?action=` filtering and `?limit=`/`?offset=` pagination (defaults 50/0, capped at 200).

## API summary

See the root project plan / `struktur folder/README.md` for the full endpoint table. In short: `POST /admin/login`, `POST /admin/logout`, `GET /admin/session`, full CRUD + publish/unpublish under `/admin/announcements`, `GET /admin/broadcast/telegram/status` + list/create/detail under `/admin/broadcast/telegram` + `POST /admin/broadcast/telegram/:id/cancel` (Slice 6), `GET /admin/analytics/summary`, `GET`/`PUT` under `/admin/versions`, `GET`/`PATCH` under `/admin/admins`, `GET /admin/audit-logs` (all of the above requiring an authenticated session, the last three superadmin-only), and the public `GET /api/announcements` / `POST /api/events` / `GET /api/version` described above.
