/**
 * Data access for `announcements`. `listPublicActive` is the one query the
 * unauthenticated public route runs — it never selects `created_by`, and
 * takes no caller-identifying argument (see routes/publicAnnouncementsRoutes.js).
 */
import { randomUUID } from 'node:crypto';
import { getDb, lazyStatement } from '../client.js';

const findByIdStmt = lazyStatement('SELECT * FROM announcements WHERE id = ?');
const insertStmt = lazyStatement(`
  INSERT INTO announcements
    (id, title, body, title_format, body_format, level, status, target_platform, starts_at, ends_at, created_by, created_at, updated_at)
  VALUES
    (@id, @title, @body, @titleFormat, @bodyFormat, @level, 'draft', @targetPlatform, @startsAt, @endsAt, @createdBy, @now, @now)
`);
const setStatusStmt = lazyStatement('UPDATE announcements SET status = ?, updated_at = ? WHERE id = ?');
const deleteStmt = lazyStatement('DELETE FROM announcements WHERE id = ?');

export function listAnnouncements({ status, level } = {}) {
  const clauses = [];
  const params = {};
  if (status) {
    clauses.push('status = @status');
    params.status = status;
  }
  if (level) {
    clauses.push('level = @level');
    params.level = level;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return getDb().prepare(`SELECT * FROM announcements ${where} ORDER BY created_at DESC`).all(params);
}

/**
 * Only rows that are published AND currently inside their schedule window
 * (an unset start/end boundary means "no limit" on that side). This is the
 * exact definition of "active" the public endpoint promises.
 */
export function listPublicActiveAnnouncements({ platform } = {}) {
  const now = new Date().toISOString();
  const clauses = [
    "status = 'published'",
    '(starts_at IS NULL OR starts_at <= @now)',
    '(ends_at IS NULL OR ends_at >= @now)'
  ];
  const params = { now };
  if (platform && platform !== 'all') {
    clauses.push("(target_platform = @platform OR target_platform = 'all')");
    params.platform = platform;
  }
  return getDb()
    .prepare(
      `SELECT id, title, body, title_format, body_format, level, target_platform, starts_at, ends_at, created_at, updated_at
       FROM announcements
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC`
    )
    .all(params);
}

export function findAnnouncementById(id) {
  return findByIdStmt().get(id) ?? null;
}

export function createAnnouncement({ title, body, titleFormat, bodyFormat, level, targetPlatform, startsAt, endsAt, createdBy }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  insertStmt().run({
    id,
    title,
    body,
    // Prompt 0163 — defaults to 'plain' at the repo layer too (not just the
    // column's own DEFAULT), since this INSERT always specifies the column
    // explicitly — a caller that omits titleFormat/bodyFormat entirely
    // (any pre-0163 caller, or a raw script) still gets the same
    // backward-compatible 'plain' value the migration's own DEFAULT
    // promises for a column left out of the INSERT altogether.
    titleFormat: titleFormat ?? 'plain',
    bodyFormat: bodyFormat ?? 'plain',
    level,
    targetPlatform,
    startsAt: startsAt ?? null,
    endsAt: endsAt ?? null,
    createdBy,
    now
  });
  return findByIdStmt().get(id);
}

/** Partial update — only columns present in `fields` are touched. */
export function updateAnnouncement(id, fields) {
  const allowed = ['title', 'body', 'title_format', 'body_format', 'level', 'target_platform', 'starts_at', 'ends_at'];
  const toColumn = {
    title: 'title',
    body: 'body',
    titleFormat: 'title_format',
    bodyFormat: 'body_format',
    level: 'level',
    targetPlatform: 'target_platform',
    startsAt: 'starts_at',
    endsAt: 'ends_at'
  };
  const sets = [];
  const params = { id, now: new Date().toISOString() };
  for (const [key, column] of Object.entries(toColumn)) {
    if (!(key in fields)) continue;
    if (!allowed.includes(column)) continue;
    sets.push(`${column} = @${column}`);
    params[column] = fields[key] ?? null;
  }
  if (sets.length === 0) return findByIdStmt().get(id);
  getDb().prepare(`UPDATE announcements SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
  return findByIdStmt().get(id);
}

export function setAnnouncementStatus(id, status) {
  setStatusStmt().run(status, new Date().toISOString(), id);
  return findByIdStmt().get(id);
}

export function deleteAnnouncement(id) {
  const result = deleteStmt().run(id);
  return result.changes > 0;
}
