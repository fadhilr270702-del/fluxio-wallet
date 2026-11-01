# Fluxio Admin Panel

React 18 + Vite frontend for the admin panel. Slice 1 shipped the app shell, real
authentication (backed by `backend/`'s session-cookie auth), and Announcements. Slice 2 added
**Broadcast → Telegram**: a composer (send to a channel or every bot subscriber) plus a
history/detail view. Slice 3 added **Analytics**: an aggregate, anonymous dashboard of
wallet-creation activity. Slice 4 added **Versions**: latest/minimum-supported app version per
platform, driving wallet apps' force/optional-update prompts. Slice 5 activates **role-based
access** (superadmin vs editor, real for the first time) and adds an **Audit Log**. Slice 6
extends Broadcast → Telegram with one-time scheduled sends and cancellation before they go out.
Sidebar: Dashboard, Announcements, Broadcast, Analytics (any admin), Versions, Audit Log, Settings
(superadmin only) — every page is real now, nothing left as "coming soon" — see `CLAUDE.md` at
the repo root for the project-wide "what's real vs scaffold" status.

## Getting started

```bash
cd backend
cp .env.example .env
pnpm create-admin -- --email=you@example.com --password=at-least-8-chars
pnpm dev                    # backend on http://localhost:4000

# in a second terminal
cd admin
pnpm dev                    # http://localhost:4174
```

`pnpm install` from the repo root also works and picks up this workspace package. There's
nothing to configure for local dev — `vite.config.js` proxies `/admin` and `/api` requests to
`http://localhost:4000`, so the session cookie round-trips same-origin without any `.env`
needed. `.env.example`'s `VITE_API_BASE_URL` only matters for a production build served from a
different origin than the backend (see backend/README.md's `ADMIN_ORIGIN` CORS setting, which
must then be set to match).

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Vite dev server, port 4174 |
| `pnpm build` | Production build to `dist/` |
| `pnpm preview` | Serve the production build locally |

## How auth works here

`src/app/AuthContext.jsx` is the single source of truth for "who is logged in" — on mount it
calls `GET /admin/session`, which succeeds or fails based on the httpOnly session cookie the
backend already issued (nothing is read from localStorage; the cookie is the only credential).
`ProtectedRoute.jsx` wraps every route except `/login` and redirects to it if that check comes
back unauthenticated. `useAuth()` (in `src/hooks/useAuth.js`) is how any component reads the
current admin or calls `login()`/`logout()`.

There is no signup screen — accounts are created via `backend/scripts/createAdmin.js` only. An
existing admin's role/active status can be changed from `/settings` (superadmin only) — see
"Roles & permissions" below. Because sessions are DB-backed rather than JWTs, a role change
takes effect on that admin's *next* request, not just their next login.

## Non-custodial reminder

This panel never touches a private key, seed phrase, or wallet address. Announcements and
Telegram broadcasts are both one-way — there's no "who read this" tracking anywhere in this
codebase, by design (see `backend/README.md`'s sections on the public announcements endpoint
and the Telegram broadcast queue/worker). Analytics is aggregate-only in the same spirit: there
is no page anywhere in this panel that lists an individual wallet's events — every number on
`/analytics` is a count or a breakdown.

## Broadcast → Telegram

`/broadcast/telegram` (the composer) and `/broadcast/history` are two routes under one small
tab strip (`features/broadcast/telegram/BroadcastTabs.jsx`) rather than a nested sidebar entry
— `Sidebar.jsx`'s existing single "Broadcast" link just redirects into the composer. The
composer shows live bot-connectivity and active-subscriber-count info (from
`GET /admin/broadcast/telegram/status`) and disables sending if the backend has no
`TELEGRAM_BOT_TOKEN` configured, rather than letting a submit silently fail. History shows
every past broadcast's status/progress; its detail view lists failed recipients (subscriber
sends only — capped, not every recipient) for debugging.

**Scheduling (Slice 6)** — the composer has a "Send now" / "Schedule for later" toggle; picking
the latter shows a `datetime-local` field (past times rejected client-side via `min` and
authoritatively by the backend) interpreted in the admin's own local timezone and converted to
UTC on submit, reusing `utils/formatDate.js`'s existing `toDatetimeLocalValue`/
`fromDatetimeLocalValue` helpers verbatim (the same pattern Announcements' `startsAt`/`endsAt`
already used since Slice 1 — no new utility code). A `scheduled` broadcast shows its scheduled
time (converted back to local time for display) and a **Cancel** button in both the history table
and the detail page — the button only appears while status is still `scheduled`; once the worker
activates it (or it completes/fails), the button disappears and cancelling is rejected server-side
regardless. Canceling asks for confirmation, calls `POST .../:id/cancel`, then reloads — if the
worker won the race and activated it in the meantime, the reload just shows its real current
status instead of a stale "scheduled" row.

## Analytics

`/analytics` fetches `GET /admin/analytics/summary` once on mount and renders three stat tiles
(all-time wallets created, top platform, top chain), a 30-day daily-trend chart, and two ranked
breakdown lists (platform, chain). No retention metric — a one-time `WALLET_CREATED` event alone
can't show whether a wallet came back later; see `backend/README.md`'s Analytics section for why,
and the note rendered directly on the page. Charts (`components/RankedBarList.jsx`,
`features/analytics/DailyTrendChart.jsx`) are plain HTML/CSS proportional bars, not SVG or a
charting library — simpler for this exact shape, and this repo has no charting dependency
anywhere to build on.

## Versions

`/versions` fetches `GET /admin/versions` once on mount and renders one independent form per
platform (web/extension/mobile) — latest version, minimum-supported version, and an optional
update message. Each platform saves separately (`PUT /admin/versions/:platform`), so editing one
never risks the other two. Not in `Settings` — that page's documented scope is admin
account/role management, a different concern — so this got its own sidebar entry instead.
**Superadmin-only as of Slice 5** — a misconfigured minimum version can lock out every user on a
platform.

## Roles & permissions

Two roles: `superadmin` (full access) and `editor` (content management only — Announcements,
Broadcast, plus read-only Dashboard/Analytics). `Versions`, `Audit Log`, and `Settings` are
superadmin-only. Enforced twice, deliberately:
- **`Sidebar.jsx`** filters `NAV_ITEMS` by an optional `roles` field before rendering — an editor
  never even sees a link to a page they can't use.
- **`components/RequireRole.jsx`** wraps those three routes' content inside `<ProtectedRoute>` —
  the backstop for someone navigating to the URL directly. Shows a plain "Access denied" message
  rather than redirecting, since silently bouncing to another page after a deliberate navigation
  reads as more confusing than an honest denial.

`/settings` (`features/settings/AdminsPage.jsx`) replaces the old placeholder — it's the "admin
account and role management" page that placeholder always said it would eventually be. A
superadmin can change another admin's role or active status inline (immediate `PATCH`, no
separate edit form); the acting admin's own row has both controls disabled, matching the
backend's `CANNOT_MODIFY_SELF` guard. Still no way to create or delete an admin from the UI —
`backend/scripts/createAdmin.js` remains the only path.

## Audit Log

`/audit-log` (`features/audit-log/AuditLogPage.jsx`) lists who did what, when — logins,
announcement publishes, Telegram broadcast sends/schedules/cancels (Slice 6 added the latter
two), version changes, and admin role/status changes. An action-filter toolbar plus a
"Load more" button (offset pagination) rather than a
full paginator — this is a log read occasionally, not paged through constantly. Target is shown
as `type · id` as-is, not resolved to a human label (e.g. an announcement's actual title) — that
would need a per-target-type join this slice doesn't add.

## Structure

Mirrors `apps/web`'s conventions (same design tokens, same app-shell CSS classes, same
`src/app` / `src/components` / `src/features` / `src/hooks` / `src/services` / `src/styles`
split) rather than inventing a new one:

```
src/
├── app/            # main.jsx, App.jsx (routes), AuthContext.jsx
├── components/      # AppShell, Sidebar, Navbar, ThemeToggle, ProtectedRoute, RequireRole,
│                      StatTile, Badge, Icon, RankedBarList
├── features/
│   ├── auth/Login.jsx
│   ├── dashboard/Dashboard.jsx
│   ├── announcements/        # Slice 1's complete feature
│   ├── broadcast/telegram/   # Slice 2's complete feature — Compose/History/Detail + tab strip; Slice 6 added scheduling + cancel
│   ├── analytics/            # Slice 3's complete feature — AnalyticsPage.jsx, DailyTrendChart.jsx
│   ├── versions/              # Slice 4's complete feature — VersionsPage.jsx (superadmin-only)
│   ├── audit-log/             # Slice 5 — AuditLogPage.jsx (superadmin-only)
│   └── settings/               # Slice 5 — AdminsPage.jsx (superadmin-only, replaces the old placeholder)
├── hooks/           # useTheme.js, useAuth.js
├── services/        # apiClient.js, authApi.js, announcementsApi.js, telegramBroadcastApi.js,
│                      analyticsApi.js, versionsApi.js, adminsApi.js, auditLogApi.js
└── styles/          # design.css (verbatim copy of apps/web's — see its header comment), admin.css
```
