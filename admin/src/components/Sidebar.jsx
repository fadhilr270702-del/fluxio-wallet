import React from 'react';
import { NavLink } from 'react-router-dom';
import Icon from './Icon.jsx';
import BotSwitcher from './BotSwitcher.jsx';
import useAuth from '../hooks/useAuth.js';

// `roles` omitted = visible to any authenticated admin. When present, the
// item is filtered out entirely for a role that isn't listed — an editor
// never even sees a Versions/Audit Log/Settings link, not just a blocked
// one (RequireRole.jsx is the backstop if they navigate to the URL directly).
const NAV_ITEMS = [
  { to: '/dashboard', icon: 'dashboard', label: 'Dashboard' },
  { to: '/announcements', icon: 'megaphone', label: 'Announcements' },
  { to: '/broadcast', icon: 'broadcast', label: 'Broadcast' },
  { to: '/analytics', icon: 'chart', label: 'Analytics' },
  // No `roles` — every authenticated admin gets self-service account
  // access (prompt 0181), unlike /settings (managing OTHER admins).
  { to: '/account', icon: 'lock', label: 'My Account' },
  { to: '/versions', icon: 'refresh', label: 'Versions', roles: ['superadmin'] },
  { to: '/audit-log', icon: 'clock', label: 'Audit Log', roles: ['superadmin'] },
  { to: '/settings', icon: 'settings', label: 'Settings', roles: ['superadmin'] }
];

export default function Sidebar() {
  const { admin } = useAuth();
  const items = NAV_ITEMS.filter((item) => !item.roles || item.roles.includes(admin?.role));

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button className="brand" aria-label="Fluxio Admin">
          <img src="/logo.png" alt="" className="brand-logo" />
          <span className="brand-word" style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18 }}>
            Fluxio <span style={{ color: 'var(--gold)' }}>Admin</span>
          </span>
        </button>
      </div>
      <nav className="sidebar-nav">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `nav-item ${isActive ? 'nav-item--active' : ''}`}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      {/* BotSwitcher is pinned to the bottom of the sidebar via its own
          `margin-top:auto` (`.bot-switcher`, admin.css — prompt 0189, which
          removed the half-built collapse toggle that used to hold that pin). */}
      <BotSwitcher />
    </aside>
  );
}
