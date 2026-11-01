import React from 'react';
import Icon from './Icon.jsx';
import HeaderClock from './HeaderClock.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import BackgroundToggle from './BackgroundToggle.jsx';
import useAuth from '../hooks/useAuth.js';

/** "john.doe@..." -> "JD"; "fadhilr270702@..." (no separator) -> first two chars, uppercased. */
function getInitials(email) {
  if (!email) return '?';
  const local = email.split('@')[0];
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

export default function Navbar() {
  const { admin, logout } = useAuth();

  return (
    <header className="navbar topbar">
      <div className="nav-left">
        <span className="logo" style={{ fontFamily: 'var(--font-display)' }}>Fluxio Admin</span>
      </div>
      <div className="nav-center">
        <HeaderClock />
      </div>
      <div className="nav-right">
        <div className="nav-actions admin-user">
          {admin && (
            <>
              {/* tabIndex + :focus-visible (admin.css) makes the tooltip reachable by keyboard, not just mouse hover. */}
              <div className="avatar-wrap" tabIndex={0}>
                <div className="avatar">{getInitials(admin.email)}</div>
                <span className="avatar-tooltip">{admin.email}</span>
              </div>
              <span className="admin-user__role">{admin.role}</span>
            </>
          )}
          <BackgroundToggle />
          <ThemeToggle />
          <button className="icon-btn" onClick={logout} aria-label="Log out">
            <Icon name="logout" />
          </button>
        </div>
      </div>
    </header>
  );
}
