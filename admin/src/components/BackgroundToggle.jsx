import React from 'react';
import useSurface from '../hooks/useSurface.js';

/**
 * Prompt 0197 — the Background on/off switch, next to ThemeToggle in the
 * Navbar. A plain track+knob switch (not a glass pill): ON = 'glass'
 * (photo + glass cards, the default), OFF = 'solid'. The outer button
 * reuses .icon-btn so its height/border/spacing match ThemeToggle and
 * Log out exactly; role="switch" + aria-checked carry the state, the
 * accessible name stays "Background" (state is aria-checked's job, per
 * this prompt's own spec), and title mirrors it as a tooltip.
 */
export default function BackgroundToggle() {
  const { surface, toggle } = useSurface();
  const on = surface === 'glass';

  return (
    <button
      type="button"
      className="icon-btn bg-toggle"
      role="switch"
      aria-checked={on}
      aria-label="Background"
      title={on ? 'Background on' : 'Background off'}
      onClick={toggle}
    >
      <span className="bg-toggle__track" aria-hidden="true">
        <span className="bg-toggle__knob" />
      </span>
    </button>
  );
}
