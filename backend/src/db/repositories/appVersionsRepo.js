/**
 * Data access for `app_versions` — one row per platform, upserted directly
 * by admins. See db/migrations/0006_create_app_versions.sql.
 */
import { randomUUID } from 'node:crypto';
import { lazyStatement } from '../client.js';

const PLATFORMS = ['web', 'extension', 'mobile'];

const findByPlatformStmt = lazyStatement('SELECT * FROM app_versions WHERE platform = ?');
const upsertStmt = lazyStatement(`
  INSERT INTO app_versions (id, platform, latest_version, min_supported_version, update_message, update_message_format, updated_by, created_at, updated_at)
  VALUES (@id, @platform, @latestVersion, @minSupportedVersion, @updateMessage, @updateMessageFormat, @updatedBy, @now, @now)
  ON CONFLICT(platform) DO UPDATE SET
    latest_version = excluded.latest_version,
    min_supported_version = excluded.min_supported_version,
    update_message = excluded.update_message,
    update_message_format = excluded.update_message_format,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at
`);

export function findByPlatform(platform) {
  return findByPlatformStmt().get(platform) ?? null;
}

/** Always returns exactly 3 entries (one per platform) — unconfigured platforms get a null-valued placeholder, not omitted, so the admin UI can always render all 3 forms. */
export function listAllPlatforms() {
  return PLATFORMS.map((platform) => {
    const row = findByPlatform(platform);
    return (
      row ?? {
        id: null,
        platform,
        latest_version: null,
        min_supported_version: null,
        update_message: null,
        // Prompt 0163 — null here too (not 'plain'), consistent with every
        // other field on this synthesized placeholder: there is no real row
        // for this platform at all yet, so nothing about it is genuinely
        // known, format included.
        update_message_format: null,
        updated_by: null,
        created_at: null,
        updated_at: null
      }
    );
  });
}

export function upsertPlatformVersion({ platform, latestVersion, minSupportedVersion, updateMessage, updateMessageFormat, updatedBy }) {
  const existing = findByPlatform(platform);
  const now = new Date().toISOString();
  upsertStmt().run({
    id: existing?.id ?? randomUUID(),
    platform,
    latestVersion,
    minSupportedVersion,
    updateMessage: updateMessage ?? null,
    // Prompt 0163 — defaults to 'plain' at the repo layer too, same
    // reasoning as announcementsRepo.js's own createAnnouncement: this
    // INSERT/UPSERT always specifies the column explicitly, so a caller
    // that omits updateMessageFormat still gets the same backward-
    // compatible 'plain' value the migration's own column DEFAULT promises.
    updateMessageFormat: updateMessageFormat ?? 'plain',
    updatedBy,
    now
  });
  return findByPlatform(platform);
}
