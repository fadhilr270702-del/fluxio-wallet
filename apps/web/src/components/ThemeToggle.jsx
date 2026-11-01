import React from 'react';
import useTheme from '../hooks/useTheme.js';

export default function ThemeToggle() {
  const { theme, toggle } = useTheme();

  return (
    <div style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 50 }}>
      <button className="icon-btn" onClick={toggle}>
        {theme === 'dark' ? '☀ Light' : '☾ Dark'}
      </button>
    </div>
  );
}
