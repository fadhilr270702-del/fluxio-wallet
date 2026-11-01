import React from 'react';

/** Small "03 / 09" numbered badge rendered inside a horizontal-scroll slide,
 *  reinforcing that the page moves through a fixed sequence of sections. */
export default function SlideTag({ index, count }) {
  return (
    <span className="slide-tag" aria-hidden="true">
      {String(index).padStart(2, '0')} <em>/ {String(count).padStart(2, '0')}</em>
    </span>
  );
}
