import React, { useEffect, useRef, useState } from 'react';
import useIsVisible from '../../../hooks/useIsVisible.js';
import useResolvedBotId from '../../../hooks/useResolvedBotId.js';
import PremiumEmojiStatic from './PremiumEmojiStatic.jsx';
import { fetchEmojiFile } from '../../../services/emojiPacksApi.js';
import { sharedEmojiAnimationSlots } from './emojiAnimationSlots.js';

/**
 * Prompt 0152 — the real, moving preview of a registered custom emoji.
 * Shared component, built for 0153 (the composer picker) to reuse as-is,
 * not just this library page's own grid.
 *
 * Performance strategy, all four pieces required by the base prompt:
 *  1. Lazy-load via IntersectionObserver (useIsVisible) — nothing fetches
 *     until actually scrolled into view.
 *  2. Shows PremiumEmojiStatic (the thumbnail) until the real animation
 *     asset has actually loaded — never a blank tile while waiting.
 *  3. A concurrency cap (emojiAnimationSlots.js, default 24 site-wide) —
 *     a tile that's visible but can't get a slot just keeps showing its
 *     static thumbnail instead of playing.
 *  4. Releases its slot (and tears down the Lottie instance / stops the
 *     video) the instant it scrolls back out of view.
 *
 * `lottie-web` is dynamically imported only once a TGS asset is actually
 * about to play — never part of the initial admin bundle — same
 * lazy-import pattern EmojiPickerButton.jsx already established for
 * emoji-mart in prompt 0147.
 *
 * Prompt 0161 — `botId` resolved once via `useResolvedBotId()` (explicit
 * prop still wins over context — see that hook's own header) and reused
 * for both this component's own fetch AND the nested `PremiumEmojiStatic`
 * fallback below, rather than letting each resolve independently — this
 * is deliberate, not just simpler: if a caller ever passes an explicit
 * override prop straight to THIS component, that override needs to
 * cascade into its own static-fallback rendering too, which only works if
 * the already-resolved value is what gets forwarded, not the raw
 * (possibly absent) prop.
 */
export default function PremiumEmojiAnimated({ botId: botIdProp, customEmojiId, isAnimated, isVideo, size = 32, alt = '' }) {
  const botId = useResolvedBotId(botIdProp, 'PremiumEmojiAnimated');
  const [ref, isVisible] = useIsVisible({ rootMargin: '100px' });
  const [hasSlot, setHasSlot] = useState(false);
  const [ready, setReady] = useState(false);
  const [videoUrl, setVideoUrl] = useState(null);
  const lottieContainerRef = useRef(null);
  const lottieInstanceRef = useRef(null);
  // Stable per mounted instance — two PremiumEmojiAnimated tiles for the
  // SAME emoji (unlikely, but not impossible if a future caller ever
  // renders one twice) must not fight over one slot key.
  const slotIdRef = useRef(`${botId}:${customEmojiId}:${Math.random().toString(36).slice(2)}`);

  // Acquire/release a slot purely as a function of visibility — retries
  // via the shared manager's subscribe() whenever some OTHER tile releases
  // one, so a tile that loaded while the grid was already at capacity
  // still gets its turn once room frees up, without polling.
  useEffect(() => {
    const id = slotIdRef.current;
    if (!isVisible) {
      sharedEmojiAnimationSlots.releaseSlot(id);
      setHasSlot(false);
      return undefined;
    }
    if (sharedEmojiAnimationSlots.acquireSlot(id)) {
      setHasSlot(true);
      return () => sharedEmojiAnimationSlots.releaseSlot(id);
    }
    const unsubscribe = sharedEmojiAnimationSlots.subscribe(() => {
      if (sharedEmojiAnimationSlots.acquireSlot(id)) {
        setHasSlot(true);
        unsubscribe();
      }
    });
    return () => {
      unsubscribe();
      sharedEmojiAnimationSlots.releaseSlot(id);
    };
  }, [isVisible]);

  // Fetches + plays the real asset only once BOTH visible and holding a
  // slot; tears everything down the moment either stops being true.
  useEffect(() => {
    if (!isVisible || !hasSlot) {
      setReady(false);
      if (lottieInstanceRef.current) {
        lottieInstanceRef.current.destroy();
        lottieInstanceRef.current = null;
      }
      return undefined;
    }

    if (!isAnimated && !isVideo) {
      // A static (non-animated, non-video) custom emoji — its thumbnail IS
      // the final look, nothing further to fetch.
      setReady(true);
      return undefined;
    }

    let canceled = false;

    if (isVideo) {
      fetchEmojiFile(botId, customEmojiId)
        .then((blob) => {
          if (canceled) return;
          setVideoUrl(URL.createObjectURL(blob));
          setReady(true);
        })
        .catch(() => {
          /* stays on the static thumbnail fallback (ready never becomes true) */
        });
    } else {
      fetchEmojiFile(botId, customEmojiId)
        .then((blob) => blob.text())
        .then((text) => {
          if (canceled) return null;
          const animationData = JSON.parse(text);
          return import('lottie-web').then(({ default: lottie }) => {
            if (canceled || !lottieContainerRef.current) return;
            lottieInstanceRef.current = lottie.loadAnimation({
              container: lottieContainerRef.current,
              renderer: 'svg',
              loop: true,
              autoplay: true,
              animationData
            });
            setReady(true);
          });
        })
        .catch(() => {
          /* stays on the static thumbnail fallback */
        });
    }

    return () => {
      canceled = true;
      if (lottieInstanceRef.current) {
        lottieInstanceRef.current.destroy();
        lottieInstanceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, hasSlot, isAnimated, isVideo, botId, customEmojiId]);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const showStaticFallback = !ready || (!isAnimated && !isVideo);
  // Mounted the WHOLE time an attempt is in flight (visible + holding a
  // slot), not just once `ready` — the effect above needs
  // lottieContainerRef.current to already exist in the DOM before it can
  // create the animation and set `ready` true; gating this div on `ready`
  // itself made that ref permanently null (a real bug caught live: 60
  // visible, fetchable emoji all silently stayed on their static thumbnail
  // forever, with the fetch/decode succeeding and only the final
  // `lottie.loadAnimation()` call skipped every time via its own
  // `!lottieContainerRef.current` guard). Hidden via CSS, not unmounted,
  // while not yet ready — swapping it in and out would tear down/recreate
  // the very container the animation is attached to.
  const attemptingLottie = isVisible && hasSlot && isAnimated && !isVideo;

  return (
    <span ref={ref} className="premium-emoji premium-emoji--animated" style={{ width: size, height: size }}>
      {showStaticFallback && <PremiumEmojiStatic botId={botId} customEmojiId={customEmojiId} size={size} alt={alt} />}
      {ready && isVideo && videoUrl && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video src={videoUrl} width={size} height={size} autoPlay loop muted playsInline />
      )}
      {attemptingLottie && (
        <div
          ref={lottieContainerRef}
          className="premium-emoji__lottie"
          style={{ width: size, height: size, display: ready ? 'block' : 'none' }}
        />
      )}
    </span>
  );
}
