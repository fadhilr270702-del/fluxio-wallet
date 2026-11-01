import React, { useEffect, useState } from 'react';
import { getVersions, updatePlatformVersion } from '../../services/versionsApi.js';
import RichTextEditor from '../broadcast/telegram/RichTextEditor.jsx';
import {
  editorJsonToTelegramHtml,
  validateEditorLinks,
  isEditorDocEmpty,
  bodyToEditorHtml
} from '../../components/editorTelegramFormat.js';

const PLATFORM_LABELS = { web: 'Web', extension: 'Extension', mobile: 'Mobile' };

/**
 * Prompt 0163 — Update message became a RichTextEditor field
 * (premiumEnabled={false}, same reasoning as AnnouncementForm.jsx's own
 * Title/Body: Versions aren't a Telegram concept either, and this page has
 * no <DataBotProvider>). The standalone 0159-era emoji-picker button is
 * gone — the editor's own toolbar already carries one.
 *
 * `initialUpdateMessageHtml` is computed ONCE, synchronously, from the
 * `version` prop this component receives at mount (via bodyToEditorHtml,
 * the same escape-then-parse round-trip AnnouncementForm.jsx's Body field
 * uses) — VersionsPage's own `if (!versions) return <Loading>` gate above
 * already guarantees real data is available before any PlatformVersionForm
 * ever mounts, so there's no separate loading state to wait on here the
 * way AnnouncementForm needs for its own async single-record fetch. Stays
 * unread after mount, matching RichTextEditor's own "uncontrolled past
 * mount" contract — the same reason `fields.latestVersion`/
 * `minSupportedVersion` below already never re-sync from a later `version`
 * prop change post-save.
 *
 * Update message stays genuinely optional (unlike Announcements' Title/
 * Body): an empty editor doc submits `updateMessage: null`, matching the
 * pre-existing `fields.updateMessage || null` behavior exactly.
 */
function PlatformVersionForm({ version, onSaved }) {
  const [fields, setFields] = useState({
    latestVersion: version.latestVersion || '',
    minSupportedVersion: version.minSupportedVersion || ''
  });
  const [initialUpdateMessageHtml] = useState(() => bodyToEditorHtml(version.updateMessage, version.updateMessageFormat));
  const [updateMessageDoc, setUpdateMessageDoc] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [justSaved, setJustSaved] = useState(false);

  function update(key, value) {
    setFields((f) => ({ ...f, [key]: value }));
    setJustSaved(false);
  }

  function handleUpdateMessageChange(doc) {
    setUpdateMessageDoc(doc);
    setJustSaved(false);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    let updateMessage = null;
    if (updateMessageDoc && !isEditorDocEmpty(updateMessageDoc)) {
      const linkError = validateEditorLinks(updateMessageDoc);
      if (linkError) {
        setError(linkError);
        return;
      }
      updateMessage = editorJsonToTelegramHtml(updateMessageDoc);
    }

    setSaving(true);
    try {
      const { version: updated } = await updatePlatformVersion(version.platform, {
        latestVersion: fields.latestVersion,
        minSupportedVersion: fields.minSupportedVersion,
        updateMessage,
        updateMessageFormat: updateMessage ? 'html' : 'plain'
      });
      onSaved(updated);
      setJustSaved(true);
    } catch (err) {
      setError(err.message || 'Could not save this platform.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card form-card">
      <h2 className="chart-card__title" style={{ marginBottom: 16 }}>{PLATFORM_LABELS[version.platform]}</h2>
      <form className="form-grid" onSubmit={handleSubmit}>
        {error && <div className="form-error">{error}</div>}

        <div className="form-row">
          <div className="field">
            <label htmlFor={`latest-${version.platform}`}>Latest version</label>
            <input
              id={`latest-${version.platform}`}
              placeholder="1.3.0"
              value={fields.latestVersion}
              onChange={(e) => update('latestVersion', e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor={`min-${version.platform}`}>Minimum supported version</label>
            <input
              id={`min-${version.platform}`}
              placeholder="1.0.0"
              value={fields.minSupportedVersion}
              onChange={(e) => update('minSupportedVersion', e.target.value)}
              required
            />
          </div>
        </div>

        <div className="field">
          <label>Update message (optional)</label>
          <RichTextEditor
            initialContent={initialUpdateMessageHtml}
            onChange={handleUpdateMessageChange}
            premiumEnabled={false}
          />
          <span className="field-hint">Bold, italic, underline, strikethrough, and links.</span>
        </div>

        <div className="form-actions">
          {justSaved && !saving && <span className="field-hint">Saved</span>}
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function VersionsPage() {
  const [versions, setVersions] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getVersions()
      .then((data) => setVersions(data.versions))
      .catch(() => setError('Could not load version settings.'));
  }, []);

  function handleSaved(updated) {
    setVersions((prev) => prev.map((v) => (v.platform === updated.platform ? updated : v)));
  }

  if (error) return <div className="form-error">{error}</div>;
  if (!versions) return <div className="loading-state">Loading…</div>;

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Versions</h1>
          <p className="page-head__desc">
            Set the latest and minimum-supported app version per platform. A wallet below the
            minimum is told to force-update; below latest but at/above minimum, it sees an
            optional update prompt instead. Unconfigured platforms never block anyone.
          </p>
        </div>
      </div>

      <div className="version-grid">
        {versions.map((v) => (
          <PlatformVersionForm key={v.platform} version={v} onSaved={handleSaved} />
        ))}
      </div>
    </main>
  );
}
