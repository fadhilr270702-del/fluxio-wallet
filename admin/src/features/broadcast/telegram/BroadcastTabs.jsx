import React from 'react';
import { NavLink } from 'react-router-dom';

// A small tab strip rather than a nested sidebar — reuses the exact
// toolbar-filter-button look already used by AnnouncementsPage's status
// filters, just with NavLinks since these are real routes.
export default function BroadcastTabs() {
  return (
    <div className="toolbar__filters" style={{ marginBottom: 16 }}>
      <NavLink to="/broadcast/telegram" end className={({ isActive }) => `btn btn-sm ${isActive ? 'btn-primary' : ''}`}>
        Compose
      </NavLink>
      <NavLink to="/broadcast/history" className={({ isActive }) => `btn btn-sm ${isActive ? 'btn-primary' : ''}`}>
        History
      </NavLink>
      <NavLink to="/broadcast/welcome" className={({ isActive }) => `btn btn-sm ${isActive ? 'btn-primary' : ''}`}>
        Welcome
      </NavLink>
      <NavLink to="/broadcast/emoji" className={({ isActive }) => `btn btn-sm ${isActive ? 'btn-primary' : ''}`}>
        Premium Emoji
      </NavLink>
    </div>
  );
}
