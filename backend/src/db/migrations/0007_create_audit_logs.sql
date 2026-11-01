-- Who did what, when. action is deliberately free-text (not CHECK-constrained,
-- unlike almost every other enum column in this schema) — same reasoning as
-- analytics_events.event: more actions are likely to be logged in future
-- slices, and a CHECK would force a migration per addition. The known set
-- for this slice is validated by the controllers that write here, not the
-- schema (see db/repositories/auditLogsRepo.js).
--
-- metadata is a JSON-in-TEXT column — a deliberate exception to this
-- schema's usual "normalize, don't store JSON" rule (see
-- analytics_event_chains for that rule applied). Audit-log context is
-- genuinely heterogeneous per action type (a version change and a
-- broadcast send share nothing to normalize against), which is the
-- standard shape audit logs take in practice.
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX idx_audit_logs_admin_created ON audit_logs(admin_id, created_at);
CREATE INDEX idx_audit_logs_action_created ON audit_logs(action, created_at);
