import React from 'react';

/**
 * A plain filled monochrome mark per chain — meant to look "stamped" on
 * the Networks card (prompt/0065), not animated or masked this time, just
 * a flat white silhouette. Same shape geometry already verified against a
 * reference image in the earlier video-mask slice (prompt/0063) before
 * that mechanism was reverted — the coordinates are real, re-used, not
 * re-guessed. Ethereum keeps its internal facet lines (drawn as thin dark
 * strokes over the white fill, an "etched" look) since that's real detail
 * in the official mark, not decoration invented for this component.
 */
export default function ChainMark({ chain }) {
  switch (chain) {
    case 'solana':
      return (
        <svg viewBox="0 0 100 100" className="chain-mark" aria-hidden="true">
          <polygon points="41,22 97,22 88,37 32,37" />
          <polygon points="23,42 99,42 90,57 14,57" />
          <polygon points="15,62 75,62 66,77 6,77" />
        </svg>
      );
    case 'ethereum':
      return (
        <svg viewBox="0 0 100 100" className="chain-mark" aria-hidden="true">
          <polygon points="50,12 80,50 50,88 20,50" />
          <g className="chain-mark__facet">
            <line x1="50" y1="12" x2="50" y2="54" />
            <line x1="80" y1="50" x2="50" y2="54" />
            <line x1="50" y1="88" x2="50" y2="54" />
            <line x1="20" y1="50" x2="50" y2="54" />
          </g>
        </svg>
      );
    case 'bnb':
      return (
        <svg viewBox="0 0 100 100" className="chain-mark" aria-hidden="true">
          <polygon points="50,38 62,50 50,62 38,50" />
          <polygon points="50,15 59,24 50,33 41,24" />
          <polygon points="50,67 59,76 50,85 41,76" />
          <polygon points="24,41 33,50 24,59 15,50" />
          <polygon points="76,41 85,50 76,59 67,50" />
        </svg>
      );
    case 'base':
      return (
        <svg viewBox="0 0 100 100" className="chain-mark" aria-hidden="true">
          <circle cx="50" cy="50" r="38" />
        </svg>
      );
    default:
      return null;
  }
}
