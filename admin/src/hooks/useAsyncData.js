import { useCallback, useEffect, useState } from 'react';

/**
 * Generic fetch/loading/error wrapper. Every existing page in this panel
 * repeats this boilerplate inline once (see AnalyticsPage.jsx,
 * AuditLogPage.jsx, etc.) — that's fine for a single fetch, but
 * Dashboard.jsx needs six independent ones (one per widget, each must
 * fail/load without affecting the others), so it's the first page to pull
 * this into a shared hook rather than repeating the pattern six times
 * inline. Existing pages are untouched and keep their own inline version.
 */
export default function useAsyncData(fetchFn, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchFn()
      .then(setData)
      .catch((err) => setError(err.message || 'Could not load this data.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    load();
  }, [load]);

  return { data, error, loading, reload: load };
}
