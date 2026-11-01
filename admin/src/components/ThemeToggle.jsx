import React from 'react';
import Icon from './Icon.jsx';
import useTheme from '../hooks/useTheme.js';

// Now rendered inline from Navbar.jsx's header (next to logout), not as a
// fixed bottom-right floating button — same useTheme()/localStorage logic
// as before, only where the button lives changed.
export default function ThemeToggle() {
  const { theme, toggle } = useTheme();

  return (
    <button
      className="icon-btn"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </button>
  );
}
