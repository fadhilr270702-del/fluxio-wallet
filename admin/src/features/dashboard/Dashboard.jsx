import React from 'react';
import StatTile from '../../components/StatTile.jsx';
import RankedBarList from '../../components/RankedBarList.jsx';
import DailyTrendChart from '../analytics/DailyTrendChart.jsx';
import useAsyncData from '../../hooks/useAsyncData.js';
import { getAnalyticsSummary } from '../../services/analyticsApi.js';
import { listAnnouncements } from '../../services/announcementsApi.js';
import { getTelegramStatus, listTelegramBroadcasts } from '../../services/telegramBroadcastApi.js';
import { getVersions } from '../../services/versionsApi.js';
import { getAuditLogs } from '../../services/auditLogApi.js';
import { formatDate } from '../../utils/formatDate.js';
import { BOT_CONTEXTS, otherBotId } from '../../app/BotContext.jsx';
import useBotContext from '../../hooks/useBotContext.js';
import { buildOtherBotPill, newSubscribersDeltaHint } from './dashboardHelpers.js';
import { progressLabel, recurringProgressLabel } from '../broadcast/telegram/telegramBroadcastStatus.js';
import { titlePlainText } from '../broadcast/telegram/composeRecentCards.js';

const PLATFORM_LABELS = { web: 'Web', extension: 'Extension', mobile: 'Mobile' }; // still used by VersionsStatusCard
// A superset of AuditLogPage.jsx's own map (that file is left untouched
// per this slice's scope — its map predates Slice 6 and is missing the
// schedule/cancel actions; this widget's copy is written complete).
const ACTION_LABELS = {
  'admin.login': 'Admin login',
  'announcement.publish': 'Announcement published',
  'broadcast.telegram.send': 'Telegram broadcast sent',
  'broadcast.telegram.schedule': 'Telegram broadcast scheduled',
  'broadcast.telegram.cancel': 'Telegram broadcast canceled',
  'version.update': 'App version updated',
  'admin.updated': 'Admin role/status changed',
  'welcome.update': 'Welcome message updated' // prompt 0136
};

// Real overview, replacing the old static-tile placeholder — every number
// below comes from an endpoint Slices 1-6 already shipped. Six independent
// fetches (one per data source), each with its own loading/error state, so
// one slow or failing endpoint only degrades its own tile/widget.
export default function Dashboard() {
  // Prompt 0143 — both Telegram-facing widgets below now follow whichever
  // bot the sidebar switcher currently has active, matching every other
  // Telegram-context page (Compose/History/Welcome) rather than staying
  // silently pinned to one bot regardless of context. The backend endpoint
  // itself needed no changes — getTelegramStatus() has taken a bot param
  // since prompt 0138 (resolveBotId() server-side); this was purely a
  // frontend gap, Dashboard.jsx never actually passing it.
  const { botId } = useBotContext();
  const otherBot = otherBotId(botId);

  const analytics = useAsyncData(() => getAnalyticsSummary({ days: 30 }));
  const publishedAnnouncements = useAsyncData(() => listAnnouncements({ status: 'published' }));
  // The ACTIVE bot's own status — powers both the "Telegram subscribers"
  // tile's main value below AND TelegramStatusCard (connected-as line +
  // subscriber count), which used to be two separate concerns (one
  // deliberately per-bot since 0139, one silently hardcoded) and are now
  // naturally the same fetch, since both should follow the same bot.
  const telegramStatus = useAsyncData(() => getTelegramStatus({ bot: botId }), [botId]);
  // The OTHER bot's own count — only ever consulted for the subscribers
  // tile's small "Other" pill (prompt 0190, see buildOtherBotPill — it
  // used to be a plain hint line styled identically to "Active", which
  // read like a mislabeled duplicate), so switching context never makes
  // that number disappear, just demotes it from the tile's main figure.
  // Two plain calls rather than a new batching backend endpoint, same
  // reasoning prompt 0139's own archive already gave for this shape.
  const telegramStatusOther = useAsyncData(() => getTelegramStatus({ bot: otherBot }), [otherBot]);
  // Prompt 0143's own audit found this one too, after the base fix: same
  // class of bug as the subscribers tile/Telegram bot card, just a
  // missing param rather than a hardcoded one — listTelegramBroadcasts()
  // defaults to 'test' server-side (resolveBotId()) when bot is omitted.
  const scheduledBroadcasts = useAsyncData(() => listTelegramBroadcasts({ status: 'scheduled', bot: botId }), [botId]);
  // Prompt 0235 — the newest broadcast for the Last broadcast card (any
  // status; the list endpoint already orders by created_at DESC).
  const lastBroadcast = useAsyncData(() => listTelegramBroadcasts({ bot: botId, limit: 1 }), [botId]);
  const versions = useAsyncData(() => getVersions());
  const recentActivity = useAsyncData(() => getAuditLogs({ limit: 5 }));

  return (
    <main className="dashboard">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="page-head__desc">
            Overview of admin activity — announcements, Telegram broadcasts, subscriber growth, and
            app versions at a glance. The wallet itself is non custodial: no wallet secrets or per
            wallet data exist anywhere in this panel, by design.
          </p>
        </div>
      </div>

      <div className="stat-row">
        {/* Prompt 0235 — replaces the always-zero Wallets created tile (the
            wallet beacon table was never fed by design). */}
        <StatTile
          icon="layers"
          label="New subscribers (7 days)"
          value={analytics.data ? (analytics.data.newSubscribers7d ?? '—') : '—'}
          hint={analytics.error ? 'Could not load' : newSubscribersDeltaHint(analytics.data?.newSubscribers7d, analytics.data?.newSubscribersPrev7d)}
        />
        <StatTile
          icon="megaphone"
          label="Announcements published"
          value={publishedAnnouncements.data ? publishedAnnouncements.data.announcements.length : '—'}
          hint={publishedAnnouncements.error ? 'Could not load' : undefined}
        />
        <StatTile
          icon="users"
          label="Telegram subscribers"
          value={telegramStatus.data ? telegramStatus.data.activeSubscriberCount : '—'}
          hint={telegramStatus.error ? 'Could not load' : 'Active'}
          otherBot={buildOtherBotPill(
            BOT_CONTEXTS[otherBot].label,
            telegramStatusOther.data ? telegramStatusOther.data.activeSubscriberCount : '—',
            Boolean(telegramStatusOther.error)
          )}
        />
        <StatTile
          icon="clock"
          label="Scheduled broadcasts"
          value={scheduledBroadcasts.data ? scheduledBroadcasts.data.broadcasts.length : '—'}
          hint={scheduledBroadcasts.error ? 'Could not load' : undefined}
        />
        {/* Prompt 0235 — replaces the literal zero Wallet secrets tile; its
            non custodial sentence moved into the page description above. */}
        <StatTile
          icon="check-shield"
          label="Subscribers from ads"
          value={analytics.data ? (analytics.data.subscribersFromAds ?? '—') : '—'}
          hint={analytics.error ? 'Could not load' : 'Start parameter attribution'}
        />
      </div>

      {/* Bento layout — a wide main column for the two biggest widgets (trend
          chart, recent activity) and a narrower side column for compact
          breakdowns/status cards, instead of one full-width vertical stack.
          Reuses .dashboard-bento from design.css (already defined, just
          unused by admin until now). */}
      <div className="dashboard-bento">
        <div className="dashboard-bento__main">
          <TrendChartCard analytics={analytics} />
          <RecentActivityWidget activity={recentActivity} />
        </div>
        <div className="dashboard-bento__side">
          <BreakdownCards analytics={analytics} lastBroadcast={lastBroadcast} />
          <TelegramStatusCard status={telegramStatus} />
          <VersionsStatusCard versions={versions} />
        </div>
      </div>
    </main>
  );
}

/** Reuses DailyTrendChart exactly as AnalyticsPage.jsx already renders it — no new chart code. */
function TrendChartCard({ analytics }) {
  if (analytics.loading) {
    return (
      <div className="card chart-card">
        <div className="loading-state">Loading analytics…</div>
      </div>
    );
  }
  if (analytics.error || !analytics.data) {
    return (
      <div className="card chart-card">
        <div className="form-error">Could not load analytics.</div>
      </div>
    );
  }

  const summary = analytics.data;
  // Prompt 0235 — subscriber growth (started_at per UTC day), replacing the
  // always-empty wallet trend; the official bot is the Dashboard's series.
  return (
    <div className="card chart-card">
      <div className="chart-card__head">
        <h2 className="chart-card__title">New subscribers — last 30 days (UTC days)</h2>
      </div>
      <DailyTrendChart data={summary.dailyNewSubscribers?.official ?? []} />
    </div>
  );
}

/**
 * Prompt 0235 — the side column: Subscribers by source (same summary field
 * Analytics shows, compact) and the newest broadcast at a glance, replacing
 * the always-empty wallet Platform/Chain breakdowns. Same loading posture
 * as before: quiet while the main column already surfaces the state.
 */
function BreakdownCards({ analytics, lastBroadcast }) {
  return (
    <>
      {!analytics.loading && !analytics.error && analytics.data && (
        <RankedBarList
          title="Subscribers by source"
          icon="users"
          accent="teal"
          emptyLabel="No subscribers yet"
          items={(analytics.data.telegramSubscribersBySource || []).map((row) => ({
            key: `${row.botId}:${row.source ?? 'organic'}`,
            label: `${row.source ?? 'organic'}${row.botId === 'official' ? '' : ` (${row.botId} bot)`}`,
            count: row.count
          }))}
        />
      )}
      <LastBroadcastCard lastBroadcast={lastBroadcast} />
    </>
  );
}

/** Prompt 0235 — the newest broadcast for the active bot: title, date, progress (durations and next round come from telegramBroadcastStatus, shared with History). */
function LastBroadcastCard({ lastBroadcast }) {
  const row = lastBroadcast.data?.broadcasts?.[0] ?? null;
  return (
    <div className="card chart-card">
      <div className="chart-card__head">
        <h2 className="chart-card__title">Last broadcast</h2>
      </div>
      {lastBroadcast.loading && <div className="loading-state">Loading…</div>}
      {!lastBroadcast.loading && lastBroadcast.error && <div className="form-error">Could not load broadcasts.</div>}
      {!lastBroadcast.loading && !lastBroadcast.error && !row && <div className="loading-state">No broadcasts yet</div>}
      {!lastBroadcast.loading && !lastBroadcast.error && row && (
        <>
          <p style={{ marginBottom: 6 }}><strong>{titlePlainText(row.title, row.titleFormat)}</strong></p>
          <p className="field-hint" style={{ marginBottom: 6 }}>{formatDate(row.createdAt)}</p>
          <p className="field-hint">
            {recurringProgressLabel(row) ?? (row.targetType === 'subscribers' ? progressLabel(row) : `${row.sentCount}/${row.totalCount} sent`)}
          </p>
        </>
      )}
    </div>
  );
}

function TelegramStatusCard({ status }) {
  return (
    <div className="card chart-card">
      <div className="chart-card__head">
        <h2 className="chart-card__title">Telegram bot</h2>
      </div>
      {status.loading && <div className="loading-state">Loading…</div>}
      {!status.loading && status.error && <div className="form-error">Could not load Telegram status.</div>}
      {!status.loading && !status.error && status.data && (
        <>
          <p>{telegramBotLine(status.data)}</p>
          <p className="field-hint">{status.data.activeSubscriberCount} active subscriber{status.data.activeSubscriberCount === 1 ? '' : 's'}</p>
        </>
      )}
    </div>
  );
}

function telegramBotLine({ botConfigured, botConnected, botUsername }) {
  if (!botConfigured) return 'Not configured (TELEGRAM_BOT_TOKEN unset).';
  if (!botConnected) return 'Configured, but unreachable.';
  return `Connected as @${botUsername}.`;
}

function VersionsStatusCard({ versions }) {
  return (
    <div className="card chart-card">
      <div className="chart-card__head">
        <h2 className="chart-card__title">App versions</h2>
      </div>
      {versions.loading && <div className="loading-state">Loading…</div>}
      {!versions.loading && versions.error && <div className="form-error">Could not load versions.</div>}
      {!versions.loading && !versions.error && versions.data && (
        <>
          {versions.data.versions.length === 0 ? (
            <div className="loading-state">No platforms configured yet.</div>
          ) : (
            versions.data.versions.map((v) => (
              <p key={v.platform} style={{ marginBottom: 6 }}>
                <strong>{PLATFORM_LABELS[v.platform] || v.platform}:</strong>{' '}
                {v.latestVersion || v.minSupportedVersion
                  ? `latest ${v.latestVersion || '—'}, min ${v.minSupportedVersion || '—'}`
                  : 'Not configured yet'}
              </p>
            ))
          )}
        </>
      )}
    </div>
  );
}

/** Fixed 5-row glance, not the full log — AuditLogPage.jsx is where the full, filterable, paginated log lives. */
function RecentActivityWidget({ activity }) {
  return (
    <div className="card">
      <h2 className="chart-card__title" style={{ marginBottom: 16 }}>Recent activity</h2>
      {activity.loading && <div className="loading-state">Loading…</div>}
      {!activity.loading && activity.error && <div className="form-error">Could not load recent activity.</div>}
      {!activity.loading && !activity.error && activity.data && (
        activity.data.logs.length === 0 ? (
          <div className="data-table__empty">No activity yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {activity.data.logs.map((log) => (
                  <tr key={log.id}>
                    <td className="data-table__meta">{formatDate(log.createdAt)}</td>
                    <td>{log.adminEmail}</td>
                    <td>{ACTION_LABELS[log.action] || log.action}</td>
                    <td className="data-table__meta">{log.targetType ? `${log.targetType} · ${log.targetId}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
