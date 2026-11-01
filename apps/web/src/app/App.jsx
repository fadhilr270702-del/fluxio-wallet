import React, { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, useLocation } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import Landing from '../features/landing/Landing.jsx';
import Privacy from '../features/legal/Privacy.jsx';
import Navbar from '../components/Navbar.jsx';
import Sidebar from '../components/Sidebar.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import Preloader, { HOLD_MS } from '../components/Preloader.jsx';
import Footer from '../components/Footer.jsx';
import useLenis from '../hooks/useLenis.js';
import '../styles/design.css';

/** The dashboard is an app shell (sidebar + topbar); the landing page is a full-bleed marketing page with its own nav. */
function AppShell({ children }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className={`app-root ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <main className="app-main">
        <Navbar />
        <div className="app-content">{children}</div>
        <Footer />
      </main>
      <ThemeToggle />
    </div>
  );
}

function Shell() {
  const location = useLocation();

  // Per-route canonical (prompt 0207, Search Console "duplicate without
  // user-selected canonical"): keeps index.html's static
  // <link rel="canonical"> pointing at the canonical absolute URL for
  // whichever route is active, normalizing away any trailing slash
  // (/privacy/ and /privacy both canonicalize to /privacy). No
  // react-helmet — this one tag is the only per-route head value the
  // site has.
  useEffect(() => {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    const href = `https://fluxiowallet.com${path === '/' ? '/' : path}`;
    let link = document.querySelector('link[rel="canonical"]');
    if (!link) {
      link = document.createElement('link');
      link.setAttribute('rel', 'canonical');
      document.head.appendChild(link);
    }
    link.setAttribute('href', href);
  }, [location.pathname]);

  // Privacy Policy (prompt 0122) is a public marketing-site page (Chrome
  // Web Store links to it directly), not a dashboard route — rendered
  // full-bleed here alongside Landing, same reasoning: it should look
  // like the rest of the public site (MarketingNav/MarketingFooter, the
  // permanent-dark .mkt-page theme), not the wallet app shell.
  if (location.pathname === '/') {
    return <Landing />;
  }
  if (location.pathname === '/privacy') {
    return <Privacy />;
  }

  // No routes are registered here anymore (prompt 0123 removed the
  // Dashboard mockup, the only one that ever was) — this AppShell branch
  // is pre-existing scaffolding for a future authenticated app area, kept
  // as-is since removing it outright was outside this cleanup's scope.
  // Any path other than "/" or "/privacy" now renders this empty shell
  // rather than a fake wallet mockup, the same as any unrecognized path
  // already did before this change.
  return (
    <AppShell>
      <Routes />
    </AppShell>
  );
}

function App() {
  const [loading, setLoading] = useState(true);
  useLenis();

  useEffect(() => {
    const t = setTimeout(() => setLoading(false), HOLD_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <Router>
      <AnimatePresence>{loading && <Preloader />}</AnimatePresence>
      <Shell />
    </Router>
  );
}

export default App;
