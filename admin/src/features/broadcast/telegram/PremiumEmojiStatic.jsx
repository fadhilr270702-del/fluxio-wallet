import React, { useEffect, useRef, useState } from 'react';
import useIsVisible from '../../../hooks/useIsVisible.js';
import useResolvedBotId from '../../../hooks/useResolvedBotId.js';
import { fetchEmojiThumb } from '../../../services/emojiPacksApi.js';

/**
 * Prompt 0152 — a lazy-loaded static thumbnail for one registered custom
 * emoji, through the authenticated `.../thumb` proxy (never a bare
 * `<img src>` pointed at it directly — see the backend proxy's own header
 * for why). Shared by two callers: standalone use wherever an animated
 * preview would be overkill (kept for 0153 to reuse, per the base prompt's
 * own instruction), and as PremiumEmojiAnimated's own "shown until the
 * real animation is ready" placeholder.
 *
 * Only fetches once actually scrolled into view (useIsVisible) — the whole
 * point of lazy-loading in a grid that can hold hundreds of emoji.
 *
 * Prompt 0153 — a failed fetch (e.g. its pack was later removed, so the
 * DB row backing the proxy's lookup no longer exists) now renders `alt`
 * itself as visible text — every real caller already passes the emoji's
 * own plain fallback character there — rather than a generic "?" glyph,
 * per that prompt's own explicit "fall back to the fallback emoji when the
 * asset isn't available" requirement for list/detail rendering.
 *
 * A real bug caught live during 0153's own verification, fixed here: a
 * caller whose own `botId` prop briefly resolves to `undefined` on an
 * early render (e.g. a parent object still settling) then corrects itself
 * on a later render of the SAME mounted instance used to permanently wedge
 * this component in its `failed` state — the old effect's guard
 * (`objectUrl || failed`) skipped every future attempt, including the one
 * for the now-correct `botId`, because `failed` never got a chance to
 * reset. Fixed with an explicit "did the (botId, customEmojiId) key itself
 * change" check, via a ref, that resets `objectUrl`/`failed` ONLY when the
 * key actually changes — never on an unrelated re-render or a plain
 * `isVisible` toggle, which would otherwise flicker/refetch an
 * already-successfully-loaded thumbnail for no reason.
 *
 * Prompt 0161 — `botId` is now resolved via `useResolvedBotId()` (an
 * explicit prop still wins, per that hook's own contract) instead of
 * trusted as-given: every caller used to have to remember to thread a
 * `botId` prop all the way down by hand, and it silently went missing
 * twice (prompts 0153, 0155) with no error, just a permanently-empty
 * placeholder. A genuinely missing resolution now degrades to the SAME
 * placeholder visually (nothing about this component's own rendering
 * changed) but is loud in dev — see that hook's own header.
 */
export default function PremiumEmojiStatic({ botId: botIdProp, customEmojiId, size = 32, alt = '' }) {
  const botId = useResolvedBotId(botIdProp, 'PremiumEmojiStatic');
  const [ref, isVisible] = useIsVisible({ rootMargin: '200px' });
  const [objectUrl, setObjectUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const attemptedKeyRef = useRef(null);

  const key = `${botId}:${customEmojiId}`;
  useEffect(() => {
    if (attemptedKeyRef.current !== key) {
      attemptedKeyRef.current = key;
      setObjectUrl(null);
      setFailed(false);
    }
  }, [key]);

  useEffect(() => {
    // Never even attempts a fetch for a falsy botId/customEmojiId (the
    // exact case that used to reach the proxy as a literal ".../undefined/..."
    // URL and 404) — nothing meaningful to fetch yet.
    if (!isVisible || !botId || !customEmojiId || objectUrl || failed) return undefined;
    let canceled = false;
    fetchEmojiThumb(botId, customEmojiId)
      .then((blob) => {
        if (canceled) return;
        setObjectUrl(URL.createObjectURL(blob));
      })
      .catch(() => {
        if (!canceled) setFailed(true);
      });
    return () => {
      canceled = true;
    };
  }, [isVisible, botId, customEmojiId, objectUrl, failed]);

  // Revokes the object URL whenever it's replaced or this instance
  // unmounts — never left to leak for the life of the whole admin session.
  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  return (
    <span ref={ref} className="premium-emoji premium-emoji--static" style={{ width: size, height: size }}>
      {objectUrl && <img src={objectUrl} alt={alt} width={size} height={size} />}
      {!objectUrl && !failed && <span className="premium-emoji__placeholder" />}
      {failed && <span className="premium-emoji__error" title="Could not load preview">{alt}</span>}
    </span>
  );
}
