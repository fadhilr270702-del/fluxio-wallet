import React from 'react';
import Icon from './Icon.jsx';

// Plain (no framer-motion) version of apps/web's StatTile — the admin panel
// doesn't depend on framer-motion, and a dashboard of placeholder numbers
// doesn't need entrance animation.
//
// Prompt 0139 added a `breakdown` prop here (an array of `{ label, value }`
// shown as several small labeled figures side by side instead of the
// single big `value`) for the Dashboard's "Telegram subscribers" tile, to
// show both bots' counts in one tile. Prompt 0143 removed it: side-by-side
// figures crowded the tile once real screenshots were checked, and the
// underlying design goal changed anyway (the tile now follows whichever
// bot is active, not both at once — see `secondaryHint` below). Confirmed
// via grep before removing that `breakdown` had exactly one caller
// (Dashboard.jsx), so nothing else silently depended on it — same
// caution prompt 0142's own sessionStorage-key cleanup used.
//
// `otherBot` (prompt 0190 — { label, count } or null) replaces 0143's
// `secondaryHint` string prop outright: that second line reused
// `.stat-tile__hint`'s styling verbatim, so the OTHER bot's count read
// like a mislabeled duplicate of "Active" (owner's own report). It now
// renders as a small pill — an uppercase "Other" prefix + the bot's name
// + count — visually distinct from the hint above it. The pill variant
// was the owner's pick from a rendered A/B (variant A, a hairline
// divider row, was deleted along with the phase-1 toggle). The
// `secondaryHint` prop itself was removed too: Dashboard's subscribers
// tile was its only caller ever (grep-confirmed, same caution as 0143's
// own `breakdown` removal recorded above).
export default function StatTile({ icon, label, value, hint, otherBot }) {
  return (
    <div className="stat-tile">
      <div className="stat-tile__icon">
        <Icon name={icon} />
      </div>
      <div>
        <span className="stat-tile__label">{label}</span>
        <span className="stat-tile__value">{value}</span>
        {hint && <span className="stat-tile__hint">{hint}</span>}
        {otherBot && (
          <span className="stat-tile__other-pill">
            <span className="stat-tile__other-pill__prefix">Other</span>
            {otherBot.label} {otherBot.count}
          </span>
        )}
      </div>
    </div>
  );
}
