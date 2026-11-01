import React from 'react';
import Icon from './Icon.jsx';

/**
 * Generic "label + proportional bar + count" list — not analytics-specific,
 * reusable anywhere a ranked breakdown needs showing. Plain HTML/CSS bars
 * (a track <div> with a width-percent fill <div>), not SVG: simpler for
 * this exact shape, and gets free rounded ends + a free native tooltip via
 * the title attribute.
 */
export default function RankedBarList({ title, icon, items, accent = 'teal', emptyLabel = 'No data yet' }) {
  const max = Math.max(1, ...items.map((item) => item.count));

  return (
    <div className="card chart-card">
      <div className="chart-card__head">
        {icon && <Icon name={icon} />}
        <h2 className="chart-card__title">{title}</h2>
      </div>
      {items.length === 0 ? (
        <div className="loading-state">{emptyLabel}</div>
      ) : (
        <div>
          {items.map((item) => (
            <div className="ranked-bar-row" key={item.key} title={`${item.label}: ${item.count}`}>
              <span className="ranked-bar-row__label">{item.label}</span>
              <span className="ranked-bar-row__track">
                <span
                  className={`ranked-bar-row__fill ranked-bar-row__fill--${accent}`}
                  style={{ width: `${(item.count / max) * 100}%` }}
                />
              </span>
              <span className="ranked-bar-row__value">{item.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
