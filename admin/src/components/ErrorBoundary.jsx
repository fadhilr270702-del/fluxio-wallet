import React from 'react';

/**
 * Content-area error boundary (prompt 0192) — wraps ONLY `{children}`
 * inside AppShell's `.app-content`, so a page that throws during render
 * (the real case that motivated this: Dashboard.jsx reading `.length` of
 * undefined when /admin/analytics/summary comes back malformed — a
 * mid-redeploy backend, a 500 with an empty body, or an admin/backend
 * version skew, see prompt 0189's finding) degrades to a visible fallback
 * card while the Sidebar, Navbar, and official-mode banner — all OUTSIDE
 * this boundary — keep working, instead of React unmounting the entire
 * tree to a blank screen.
 *
 * A class component on purpose: getDerivedStateFromError/componentDidCatch
 * are still the only official React error-boundary mechanism (React 18 has
 * no hook equivalent). `resetKey` (AppShell passes location.pathname)
 * clears a caught error on route change, so a crash on one page never
 * follows the admin to the next page.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleRetry = this.handleRetry.bind(this);
    this.handleReload = this.handleReload.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[admin] content error boundary:', this.props.resetKey, error, info);
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  handleRetry() {
    this.setState({ error: null });
  }

  handleReload() {
    window.location.reload();
  }

  render() {
    if (this.state.error) {
      return (
        <div className="card error-boundary">
          <h2>This page failed to load</h2>
          <p className="error-boundary__desc">
            Something went wrong while rendering this page. The rest of the admin panel is unaffected.
          </p>
          <p className="error-boundary__message">{String(this.state.error?.message || this.state.error)}</p>
          <div className="error-boundary__actions">
            <button type="button" className="btn btn-primary" onClick={this.handleRetry}>
              Try again
            </button>
            <button type="button" className="btn" onClick={this.handleReload}>
              Reload page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
