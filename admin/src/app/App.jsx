import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './AuthContext.jsx';
import { BotContextProvider } from './BotContext.jsx';
import ProtectedRoute from '../components/ProtectedRoute.jsx';
import RequireRole from '../components/RequireRole.jsx';
import Login from '../features/auth/Login.jsx';
import Dashboard from '../features/dashboard/Dashboard.jsx';
import AnnouncementsPage from '../features/announcements/AnnouncementsPage.jsx';
import AnnouncementForm from '../features/announcements/AnnouncementForm.jsx';
import ComposePage from '../features/broadcast/telegram/ComposePage.jsx';
import HistoryPage from '../features/broadcast/telegram/HistoryPage.jsx';
import BroadcastDetailPage from '../features/broadcast/telegram/BroadcastDetailPage.jsx';
import WelcomePage from '../features/broadcast/telegram/WelcomePage.jsx';
import EmojiLibraryPage from '../features/broadcast/telegram/EmojiLibraryPage.jsx';
import AnalyticsPage from '../features/analytics/AnalyticsPage.jsx';
import VersionsPage from '../features/versions/VersionsPage.jsx';
import AuditLogPage from '../features/audit-log/AuditLogPage.jsx';
import AdminsPage from '../features/settings/AdminsPage.jsx';
import AccountPage from '../features/account/AccountPage.jsx';
import '../styles/design.css';
import '../styles/admin.css';

// Inline <Routes>/<Route>, deliberately mirroring apps/web/src/app/App.jsx's
// structure rather than a routes-config file — this repo's convention (see
// CLAUDE.md) is that the live route tree lives directly in App.jsx.
function App() {
  return (
    <Router>
      <AuthProvider>
        {/* Prompt 0139 — nested inside AuthProvider (bot context never
            needs to survive a logout the way admin identity's own
            rehydration-on-refresh does; ordering relative to AuthProvider
            is otherwise arbitrary), outside <Routes> so it survives every
            in-app navigation between protected pages without remounting —
            a real browser reload still resets it to 'test' regardless,
            since BotContextProvider's own initial state is hardcoded, not
            read from storage (see BotContext.jsx's own comment). */}
        <BotContextProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          <Route path="/announcements" element={<ProtectedRoute><AnnouncementsPage /></ProtectedRoute>} />
          <Route path="/announcements/new" element={<ProtectedRoute><AnnouncementForm /></ProtectedRoute>} />
          <Route path="/announcements/:id/edit" element={<ProtectedRoute><AnnouncementForm /></ProtectedRoute>} />
          <Route path="/broadcast" element={<Navigate to="/broadcast/telegram" replace />} />
          <Route path="/broadcast/telegram" element={<ProtectedRoute><ComposePage /></ProtectedRoute>} />
          <Route path="/broadcast/telegram/:id/edit" element={<ProtectedRoute><ComposePage /></ProtectedRoute>} />
          <Route path="/broadcast/history" element={<ProtectedRoute><HistoryPage /></ProtectedRoute>} />
          <Route path="/broadcast/history/:id" element={<ProtectedRoute><BroadcastDetailPage /></ProtectedRoute>} />
          <Route path="/broadcast/welcome" element={<ProtectedRoute><WelcomePage /></ProtectedRoute>} />
          <Route path="/broadcast/emoji" element={<ProtectedRoute><EmojiLibraryPage /></ProtectedRoute>} />
          <Route path="/analytics" element={<ProtectedRoute><AnalyticsPage /></ProtectedRoute>} />
          {/* Prompt 0181 — self-service account page: ProtectedRoute only,
              deliberately NO RequireRole (editors change their own password
              too; /settings stays superadmin-only because it manages OTHER
              people's accounts). */}
          <Route path="/account" element={<ProtectedRoute><AccountPage /></ProtectedRoute>} />
          <Route
            path="/versions"
            element={<ProtectedRoute><RequireRole roles={['superadmin']}><VersionsPage /></RequireRole></ProtectedRoute>}
          />
          <Route
            path="/audit-log"
            element={<ProtectedRoute><RequireRole roles={['superadmin']}><AuditLogPage /></RequireRole></ProtectedRoute>}
          />
          <Route
            path="/settings"
            element={<ProtectedRoute><RequireRole roles={['superadmin']}><AdminsPage /></RequireRole></ProtectedRoute>}
          />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
        </BotContextProvider>
      </AuthProvider>
    </Router>
  );
}

export default App;
