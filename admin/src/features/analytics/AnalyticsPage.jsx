import React, { useEffect, useState } from 'react';
import StatTile from '../../components/StatTile.jsx';
import RankedBarList from '../../components/RankedBarList.jsx';
import DailyTrendChart from './DailyTrendChart.jsx';
import { getAnalyticsSummary } from '../../services/analyticsApi.js';
import { topSource, subscribersBySourceItems } from './analyticsHelpers.js';

// Prompt 0235 — this page is now about TELEGRAM SUBSCRIBERS, the one
// audience signal the backend genuinely has. The old wallet-creation cards
// all read analytics_events, a beacon table that has never received a row
// (the extension sends no signals — an explicit owner decision), so every
// one of them was zero forever. The backend keeps serving the old fields
// for compatibility; this page just stops rendering them.
const BOT_SERIES = [
  { id: 'official', label: 'Official bot' },
  { id: 'test', label: 'Test bot' }
];

export default function AnalyticsPage() {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [chartBot, setChartBot] = useState('official');

  useEffect(() => {
    getAnalyticsSummary({ days: 30 })
      .then(setSummary)
      .catch(() => setError('Could not load analytics.'));
  }, []);

  if (error) return <div className="form-error">{error}</div>;
  if (!summary) return <div className="loading-state">Loading…</div>;

  const top = topSource(summary.telegramSubscribersBySource);

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p className="page-head__desc">
            Aggregate Telegram subscriber activity for the official bot — growth, acquisition source,
            and attrition. Counts only, never an individual subscriber view; nothing here is linked to
            any wallet, and no per wallet data exists anywhere in this panel.
          </p>
        </div>
      </div>

      <div className="stat-row">
        <StatTile icon="layers" label="Subscribers (active)" value={summary.activeSubscribers ?? '—'} />
        <StatTile
          icon="users"
          label="Top source"
          value={top ? top.source : '—'}
          hint={top ? `${top.count} subscriber${top.count === 1 ? '' : 's'}` : 'No attributed subscribers yet'}
        />
        <StatTile icon="chart" label="New today" value={summary.newSubscribersToday ?? '—'} hint="UTC day" />
      </div>

      <div className="card chart-card">
        <div className="chart-card__head">
          <h2 className="chart-card__title">New subscribers — last 30 days (UTC days)</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            {BOT_SERIES.map((bot) => (
              <button
                key={bot.id}
                type="button"
                className={`btn btn-sm${chartBot === bot.id ? ' btn-primary' : ''}`}
                onClick={() => setChartBot(bot.id)}
              >
                {bot.label}
              </button>
            ))}
          </div>
        </div>
        <DailyTrendChart data={summary.dailyNewSubscribers?.[chartBot] ?? []} />
      </div>

      <div className="analytics-grid">
        <RankedBarList
          title="Subscribers by source"
          icon="users"
          accent="teal"
          emptyLabel="No subscribers yet"
          items={subscribersBySourceItems(summary.telegramSubscribersBySource)}
        />
        <div className="card chart-card">
          <div className="chart-card__head">
            <h2 className="chart-card__title">Unsubscribed / blocked (30 days)</h2>
          </div>
          <p style={{ fontSize: 32, fontWeight: 700, marginBottom: 8 }}>{summary.unsubscribed30d ?? '—'}</p>
          <p className="field-hint">
            For an inactive subscriber the last update time approximates when the block was detected
            during a send, not a dedicated timestamp.
          </p>
        </div>
      </div>

      <p className="field-hint" style={{ marginTop: 16 }}>
        Growth counts come from each subscriber's own start time, in UTC days. A subscriber who blocks
        the bot is only detected at the next send, so the unsubscribed number follows broadcasts rather
        than real time.
      </p>
    </main>
  );
}
