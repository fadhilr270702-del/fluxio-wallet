-- The admin-editable /start welcome message (prompt 0136) — replaces the
-- hardcoded constant prompt 0135 shipped with. A true singleton, same
-- `id = 1` CHECK-guard shape as telegram_poll_state (0004), not the
-- string-PK+UNIQUE-column shape app_versions (0006) uses — there's no
-- natural per-row key here the way app_versions has `platform`, since
-- there is exactly one welcome message, ever.
--
-- Deliberately NO seed row inserted here. "Behavior must not change before
-- an admin edits anything" (this prompt's own hard requirement) is
-- satisfied at the application layer instead: welcome.js's
-- getEffectiveWelcomeConfig() returns a virtual default — the exact 0135
-- constant text plus a reference to the legacy backend/assets/
-- welcome-banner.png, if present — whenever this table has no row yet. A
-- real row only starts existing the first time an admin actually saves
-- through the new Welcome tab. This avoids a migration-time INSERT needing
-- to invent an `updated_by` admin id (there may be zero admins yet on a
-- fresh deploy) or a fabricated timestamp.
--
-- image_filename is a bare filename inside backend/uploads/ (prompt 0136's
-- own new managed-upload directory — see welcomeController.js), never a
-- full/relative path and never trusted verbatim from a client without
-- re-validating both its shape and that the file actually exists there.
CREATE TABLE welcome_message (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  body TEXT NOT NULL,
  body_format TEXT NOT NULL DEFAULT 'plain' CHECK (body_format IN ('plain', 'html')),
  image_filename TEXT,
  buttons TEXT NOT NULL DEFAULT '[]',
  updated_by TEXT NOT NULL REFERENCES admins(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
