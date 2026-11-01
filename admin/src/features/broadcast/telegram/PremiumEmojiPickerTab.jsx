import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import PremiumEmojiStatic from './PremiumEmojiStatic.jsx';
import { loadPremiumEmojiLibrary } from './premiumEmojiLibraryCache.js';
import useResolvedBotId from '../../../hooks/useResolvedBotId.js';

/**
 * Prompt 0153 — the "Premium" tab content inside EmojiPickerButton's
 * popover (and the whole content of a `premiumOnly` picker, used by the
 * button-icon control). Session-cached per bot (see
 * premiumEmojiLibraryCache.js) so reopening the picker doesn't refetch.
 *
 * Search is deliberately simple, matching the base prompt's own wording —
 * a plain case-insensitive substring match against a pack's own title, or
 * an exact character match against an emoji's own fallback — not a fuzzy
 * search or a full-text index.
 *
 * Every tile is a PremiumEmojiStatic (lazy, IntersectionObserver-gated) —
 * never PremiumEmojiAnimated here: a picker can show many packs' worth of
 * emoji at once, and browsing a picker doesn't need to preview the real
 * animation to make a pick (the inserted node/icon animates for real once
 * it lands in the editor/button, via PremiumEmojiAnimated there).
 *
 * Prompt 0161 — `botId` resolved via `useResolvedBotId()`: this is now the
 * genuine leaf consumer for the whole picker (EmojiPickerButton itself no
 * longer accepts or forwards a `botId` prop at all). The active bot IS
 * always the correct source here — a picker only ever appears inside
 * Compose/Welcome's own `<DataBotProvider value={<active bot>}>` boundary,
 * never on a read-only surface (there's no "pick an emoji to insert" on a
 * page that isn't editing something).
 */
export default function PremiumEmojiPickerTab({ botId: botIdProp = null, onSelect }) {
  const botId = useResolvedBotId(botIdProp, 'PremiumEmojiPickerTab');
  const [packs, setPacks] = useState(null); // null = loading
  const [query, setQuery] = useState('');

  useEffect(() => {
    let canceled = false;
    setPacks(null);
    loadPremiumEmojiLibrary(botId).then((result) => {
      if (!canceled) setPacks(result);
    });
    return () => {
      canceled = true;
    };
  }, [botId]);

  const filteredPacks = useMemo(() => {
    if (!packs) return [];
    const q = query.trim().toLowerCase();
    if (!q) return packs;
    return packs
      .map((pack) => {
        const packMatches = pack.title.toLowerCase().includes(q);
        const emojis = packMatches ? pack.emojis : pack.emojis.filter((e) => e.fallbackEmoji.includes(query.trim()));
        return { ...pack, emojis };
      })
      .filter((pack) => pack.emojis.length > 0);
  }, [packs, query]);

  if (packs === null) {
    return <div className="premium-emoji-picker__loading">Loading…</div>;
  }

  if (packs.length === 0) {
    return (
      <div className="premium-emoji-picker__empty">
        No premium emoji packs registered yet for this bot.{' '}
        <Link to="/broadcast/emoji">Go to the Premium Emoji tab</Link> to register one.
      </div>
    );
  }

  return (
    <div className="premium-emoji-picker">
      <input
        type="text"
        className="premium-emoji-picker__search"
        placeholder="Search pack name or emoji…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <div className="premium-emoji-picker__scroll">
        {filteredPacks.length === 0 && <div className="premium-emoji-picker__empty">No matches.</div>}
        {filteredPacks.map((pack) => (
          <div key={pack.id} className="premium-emoji-picker__pack">
            <div className="premium-emoji-picker__pack-title">{pack.title}</div>
            <div className="premium-emoji-picker__grid">
              {pack.emojis.map((emoji) => (
                <button
                  key={emoji.customEmojiId}
                  type="button"
                  className="premium-emoji-picker__tile"
                  title={emoji.fallbackEmoji}
                  onClick={() => onSelect({ customEmojiId: emoji.customEmojiId, fallbackEmoji: emoji.fallbackEmoji })}
                >
                  <PremiumEmojiStatic botId={botId} customEmojiId={emoji.customEmojiId} size={28} alt={emoji.fallbackEmoji} />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
