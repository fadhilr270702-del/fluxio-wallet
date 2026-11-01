import React from 'react';

// A flex row of plain <div> bars, height scaled to the day's count — not
// SVG, same reasoning as RankedBarList.jsx. No cumulative line overlaid:
// daily counts and a cumulative total live on very different scales, so
// that stays a separate stat tile instead of a second series here.
function formatDayLabel(dayString) {
  return new Date(`${dayString}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

export default function DailyTrendChart({ data, accent = 'gold' }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const labelEvery = Math.max(1, Math.ceil(data.length / 8));
  // Index of the last day that actually gets a label — its text is
  // right-aligned to its own box (and the first label left-aligned)
  // so neither can bleed past the card edge now that labels are
  // allowed to overflow their per-day box (prompt 0188, see
  // .trend-chart__axis-text in admin.css).
  const lastLabeledIndex = Math.floor((data.length - 1) / labelEvery) * labelEvery;

  return (
    <div className="trend-chart">
      <div className="trend-chart__bars">
        {data.map((d) => (
          <div
            key={d.date}
            className="trend-chart__bar-wrap"
            title={`${formatDayLabel(d.date)}: ${d.count} new wallet${d.count === 1 ? '' : 's'}`}
          >
            <div
              className={`trend-chart__bar trend-chart__bar--${accent}`}
              style={{ height: `${Math.max(2, (d.count / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="trend-chart__axis">
        {data.map((d, i) => {
          const edge =
            i === 0
              ? ' trend-chart__axis-label--first'
              : i === lastLabeledIndex
                ? ' trend-chart__axis-label--last'
                : '';
          return (
            <span key={d.date} className={`trend-chart__axis-label${edge}`}>
              {i % labelEvery === 0 ? (
                <span className="trend-chart__axis-text">{d.date.slice(5)}</span>
              ) : (
                ''
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
