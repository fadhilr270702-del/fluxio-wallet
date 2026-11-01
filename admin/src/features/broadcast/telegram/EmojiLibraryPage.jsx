import React, { useCallback, useEffect, useState } from 'react';
import BroadcastTabs from './BroadcastTabs.jsx';
import Icon from '../../../components/Icon.jsx';
import PremiumEmojiAnimated from './PremiumEmojiAnimated.jsx';
import { formatDate } from '../../../utils/formatDate.js';
import {
  registerEmojiPack,
  listEmojiPacks,
  listEmojiPackEmojis,
  refreshEmojiPack,
  removeEmojiPack
} from '../../../services/emojiPacksApi.js';
import useBotContext from '../../../hooks/useBotContext.js';
import { DataBotProvider } from '../../../app/DataBotContext.jsx';

/**
 * Prompt 0152 — "Premium Emoji" tab (Round 1 of 2; see this prompt's own
 * header). Builds and manages the per-bot custom-emoji library; nothing
 * here ever sends a `<tg-emoji>` anywhere or touches the composer — that's
 * Round 2 (prompt 0153).
 *
 * Placed in Broadcast (not Settings) and driven by useBotContext exactly
 * like History/Welcome — the library is per-bot (a pack registered on
 * 'test' is a completely separate set of rows/file_ids from the "same"
 * pack on 'official', per the migration's own header), so it needs to
 * follow the bot switcher the same way every other bot-scoped page already
 * does. No dirty-form guard registration — like History, this page has no
 * in-progress form worth protecting across a bot switch.
 */
export default function EmojiLibraryPage() {
  const { botId } = useBotContext();
  const [packs, setPacks] = useState(null);
  const [error, setError] = useState(null);
  const [registerInput, setRegisterInput] = useState('');
  const [registering, setRegistering] = useState(false);
  const [busyPackId, setBusyPackId] = useState(null);
  const [expandedPackId, setExpandedPackId] = useState(null);
  const [expandedEmojis, setExpandedEmojis] = useState(null);
  const [expandedError, setExpandedError] = useState(null);

  const load = useCallback(() => {
    listEmojiPacks({ bot: botId })
      .then((data) => setPacks(data.packs))
      .catch(() => setError('Could not load the emoji library.'));
  }, [botId]);

  // Re-runs on every bot switch, same as History/Welcome — and collapses
  // any open pack grid, since an expanded pack's id belongs to whichever
  // bot was active when it was opened.
  useEffect(() => {
    load();
    setExpandedPackId(null);
    setExpandedEmojis(null);
  }, [load]);

  async function handleRegister(e) {
    e.preventDefault();
    if (!registerInput.trim()) return;
    setRegistering(true);
    setError(null);
    try {
      await registerEmojiPack({ bot: botId, input: registerInput.trim() });
      setRegisterInput('');
      load();
    } catch (err) {
      setError(err.message || 'Could not register this pack.');
    } finally {
      setRegistering(false);
    }
  }

  async function handleRefresh(pack) {
    setBusyPackId(pack.id);
    setError(null);
    try {
      await refreshEmojiPack(pack.id, { bot: botId });
      load();
      if (expandedPackId === pack.id) openPack(pack);
    } catch (err) {
      setError(err.message || 'Could not refresh this pack.');
    } finally {
      setBusyPackId(null);
    }
  }

  async function handleRemove(pack) {
    if (!window.confirm(`Remove "${pack.title}" and all ${pack.emojiCount} of its emoji? This cannot be undone.`)) return;
    setBusyPackId(pack.id);
    setError(null);
    try {
      await removeEmojiPack(pack.id, { bot: botId });
      if (expandedPackId === pack.id) {
        setExpandedPackId(null);
        setExpandedEmojis(null);
      }
      load();
    } catch (err) {
      setError(err.message || 'Could not remove this pack.');
    } finally {
      setBusyPackId(null);
    }
  }

  function openPack(pack) {
    setExpandedPackId(pack.id);
    setExpandedEmojis(null);
    setExpandedError(null);
    listEmojiPackEmojis(pack.id, { bot: botId })
      .then((data) => setExpandedEmojis(data.emojis))
      .catch((err) => setExpandedError(err.message || 'Could not load this pack\'s emoji.'));
  }

  function togglePack(pack) {
    if (expandedPackId === pack.id) {
      setExpandedPackId(null);
      setExpandedEmojis(null);
      return;
    }
    openPack(pack);
  }

  // Prompt 0161 — wrapped in <DataBotProvider value={botId}> (the page's
  // own active bot): every emoji rendered here always belongs to that same
  // active bot already (listEmojiPackEmojis is itself called with
  // { bot: botId } above, so emoji.botId below is never anything other than
  // this page's own botId) — provided purely so PremiumEmojiAnimated no
  // longer needs an explicit prop for it.
  return (
    <DataBotProvider value={botId}>
    <main>
      <div className="page-head">
        <div>
          <h1>Broadcast — Telegram</h1>
          <p className="page-head__desc">
            Register public custom emoji packs to build a per bot library. A premium emoji
            only plays as a moving custom emoji when the official bot (whose owner has
            Telegram Premium) sends it to a private chat or group. On the trial bot and in
            channels it always falls back to its plain fallback emoji, with no error and no
            visible sign that anything was dropped.
          </p>
        </div>
      </div>

      <BroadcastTabs />

      {error && <div className="form-error" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <form className="form-row" onSubmit={handleRegister}>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="emoji-pack-input">Pack link or name</label>
            <input
              id="emoji-pack-input"
              type="text"
              placeholder="https://t.me/addemoji/FinanceEmoji or FinanceEmoji"
              value={registerInput}
              onChange={(e) => setRegisterInput(e.target.value)}
              disabled={registering}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={registering || !registerInput.trim()}>
            {registering ? 'Registering…' : 'Register'}
          </button>
        </form>
      </div>

      {!packs ? (
        <div className="loading-state">Loading…</div>
      ) : packs.length === 0 ? (
        <div className="table-wrap"><div className="data-table__empty">No emoji packs registered for this bot yet.</div></div>
      ) : (
        <div className="emoji-pack-list">
          {packs.map((pack) => (
            <div key={pack.id} className="card emoji-pack-card">
              <button
                type="button"
                className="emoji-pack-card__header"
                onClick={() => togglePack(pack)}
                aria-expanded={expandedPackId === pack.id}
              >
                <div className="emoji-pack-card__title">
                  <strong>{pack.title}</strong>
                  <span className="field-hint">{pack.setName}</span>
                </div>
                <div className="emoji-pack-card__meta">
                  <span className="stat-tile__hint">
                    {pack.emojiCount} emoji · {pack.animatedCount} animated · {pack.videoCount} video
                  </span>
                  <span className="data-table__meta">Registered {formatDate(pack.createdAt)}</span>
                </div>
                <span className="emoji-pack-card__chevron" aria-hidden="true">▾</span>
              </button>

              <div className="emoji-pack-card__actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => handleRefresh(pack)}
                  disabled={busyPackId === pack.id}
                >
                  <Icon name="refresh" /> Refresh
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => handleRemove(pack)}
                  disabled={busyPackId === pack.id}
                >
                  <Icon name="trash" /> Remove
                </button>
              </div>

              {expandedPackId === pack.id && (
                <div className="emoji-pack-card__grid-wrap">
                  {expandedError && <div className="form-error">{expandedError}</div>}
                  {!expandedError && !expandedEmojis && <div className="loading-state">Loading emoji…</div>}
                  {expandedEmojis && (
                    <div className="emoji-grid">
                      {expandedEmojis.map((emoji) => (
                        <PremiumEmojiAnimated
                          key={emoji.customEmojiId}
                          customEmojiId={emoji.customEmojiId}
                          isAnimated={emoji.isAnimated}
                          isVideo={emoji.isVideo}
                          size={36}
                          alt={emoji.fallbackEmoji}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
    </DataBotProvider>
  );
}
