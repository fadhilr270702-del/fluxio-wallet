import React from 'react';
import { useLocation } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import Navbar from './Navbar.jsx';
import BotSwitchConfirmModal from './BotSwitchConfirmModal.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import useBotContext from '../hooks/useBotContext.js';

// Mirrors apps/web/src/app/App.jsx's inline AppShell — sidebar + topbar
// grid, same CSS classes from styles/design.css (.app-root, .app-main,
// .app-content). No Preloader/Footer here; those are marketing-site-only.
// ThemeToggle now renders from inside Navbar's header, not floated here.
export default function AppShell({ children }) {
  const { botId, pendingBotSwitch } = useBotContext();
  // Prompt 0192 — resetKey for the content error boundary below: a caught
  // crash clears itself on route change (AppShell is always inside Router).
  const location = useLocation();
  return (
    <div className="app-root">
      <Sidebar />
      <main className="app-main">
        <Navbar />
        {/* Prompt 0139 — the "unmissable" official-mode signal: a thin,
            persistent banner above every page's own content, not just a
            switcher accent color someone could plausibly miss. Rendered
            here (once, in the shell) rather than per-page, so it's
            structurally impossible for a Telegram-context page to forget
            to show it. */}
        {botId === 'official' && (
          <div className="official-mode-banner" role="status">
            <strong>BOT RESMI</strong> — aksi di sini mengirim ke user sungguhan.
          </div>
        )}
        {/* Prompt 0192 — only the page content sits inside the error
            boundary; Sidebar/Navbar/banner above stay alive when a page
            crashes (see ErrorBoundary.jsx's own header for the 0189
            blank-screen finding this exists because of). */}
        <div className="app-content">
          <ErrorBoundary resetKey={location.pathname}>{children}</ErrorBoundary>
        </div>
      </main>
      {/* Prompt 0142 — rendered here, a sibling of `.sidebar`, deliberately
          NOT from inside BotSwitcher.jsx (which lives inside `.sidebar`)
          — see BotSwitchConfirmModal.jsx's own header comment for why that
          used to matter: `.sidebar` gets `backdrop-filter`, which creates
          a containing block for `position:fixed` descendants and squeezed
          the old in-sidebar dialog into the sidebar's own narrow box.
          Conditionally rendered (not just internally returning null) so
          its own local saving/error state resets fresh every time a new
          switch attempt begins, rather than persisting stale state from a
          previous cancelled/failed attempt across the component's own
          continued lifetime. */}
      {pendingBotSwitch && <BotSwitchConfirmModal />}
    </div>
  );
}
