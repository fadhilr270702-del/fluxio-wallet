/**
 * Protected Announcements CRUD — every handler here runs behind
 * requireAuth (see routes/adminAnnouncementsRoutes.js), so `req.admin` is
 * always populated.
 */
import {
  listAnnouncements,
  findAnnouncementById,
  createAnnouncement,
  updateAnnouncement,
  setAnnouncementStatus,
  deleteAnnouncement
} from '../db/repositories/announcementsRepo.js';
import { recordAuditLog } from '../db/repositories/auditLogsRepo.js';
import { HttpError } from '../utils/httpError.js';

function toApiShape(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    titleFormat: row.title_format,
    bodyFormat: row.body_format,
    level: row.level,
    status: row.status,
    targetPlatform: row.target_platform,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function requireExisting(id) {
  const row = findAnnouncementById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Announcement not found.');
  return row;
}

export function list(req, res) {
  const { status, level } = req.query;
  const rows = listAnnouncements({ status, level });
  res.json({ announcements: rows.map(toApiShape) });
}

export function get(req, res) {
  const row = requireExisting(req.params.id);
  res.json({ announcement: toApiShape(row) });
}

export function create(req, res) {
  const row = createAnnouncement({ ...req.body, createdBy: req.admin.id });
  res.status(201).json({ announcement: toApiShape(row) });
}

export function update(req, res) {
  requireExisting(req.params.id);
  const row = updateAnnouncement(req.params.id, req.body);
  res.json({ announcement: toApiShape(row) });
}

export function publish(req, res) {
  requireExisting(req.params.id);
  const row = setAnnouncementStatus(req.params.id, 'published');
  recordAuditLog({
    adminId: req.admin.id,
    action: 'announcement.publish',
    targetType: 'announcement',
    targetId: req.params.id
  });
  res.json({ announcement: toApiShape(row) });
}

export function unpublish(req, res) {
  requireExisting(req.params.id);
  const row = setAnnouncementStatus(req.params.id, 'draft');
  res.json({ announcement: toApiShape(row) });
}

export function remove(req, res) {
  requireExisting(req.params.id);
  deleteAnnouncement(req.params.id);
  res.status(204).end();
}
