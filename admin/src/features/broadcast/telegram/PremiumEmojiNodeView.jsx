import React, { useEffect, useState } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import PremiumEmojiAnimated from './PremiumEmojiAnimated.jsx';
import PremiumEmojiStatic from './PremiumEmojiStatic.jsx';
import { lookupPremiumEmoji } from './premiumEmojiLookupCache.js';

/**
 * Prompt 0153 — the real React NodeView behind the `premiumEmoji` TipTap
 * node (see premiumEmojiNode.js's own header for the extension side).
 * `botId`/`readOnly` come from the extension's own options
 * (`.configure({botId, readOnly})` in RichTextEditor.jsx) — shared by
 * every node in this one editor instance, not stored per-node.
 *
 * Three states:
 *  - resolving (still awaiting the lookup): shows PremiumEmojiStatic as a
 *    placeholder — the same "static until ready" posture 0152 already
 *    established for a still-loading animation, just extended to cover
 *    the metadata fetch this node needs before it even knows whether to
 *    attempt an animation at all.
 *  - resolved: readOnly renders PremiumEmojiStatic (this editor mode never
 *    animates — matches ViewBroadcastModal/BroadcastDetailPage's own
 *    "readOnly body" convention); editable renders PremiumEmojiAnimated,
 *    respecting 0152's own lazy-load + concurrency-cap strategy.
 *  - lookup failed (the emoji's pack was removed, or it belongs to a
 *    different bot than the one now active): renders the PLAIN fallback
 *    TEXT, no box, no image attempt at all — the base prompt's own
 *    explicit "fallback teks kalau aset gagal" requirement.
 *
 * Prompt 0162 follow-up — this component still reads `botId` from
 * `extension.options` rather than `useResolvedBotId()` (that hook's own
 * prop/context channel doesn't apply here at all — see RichTextEditor.jsx's
 * own comment on why context can't reach a NodeView, and why the
 * extension-options mechanism itself is deliberately UNCHANGED by this
 * follow-up), but a missing `botId` here is the exact same class of bug
 * `useResolvedBotId()` exists to make loud elsewhere: a stale/never-
 * configured extension option would otherwise degrade to the SAME silent
 * empty-placeholder failure prompts 0153/0155 already hit twice. The
 * `!botId` branch below now logs a dev-only console.error naming this
 * component, in the same voice `useResolvedBotId()` uses for every other
 * leaf consumer, before falling back to the same plain-fallback-text
 * rendering this component already had.
 */
export default function PremiumEmojiNodeView({ node, extension, selected }) {
  const { botId, readOnly } = extension.options;
  const { id, fallback } = node.attrs;
  const [meta, setMeta] = useState(undefined); // undefined = resolving, null = failed, object = resolved

  useEffect(() => {
    let canceled = false;
    setMeta(undefined);
    if (!botId) {
      if (import.meta.env.DEV) {
        console.error(
          '[PremiumEmojiNodeView] no botId available for resolving a premium-emoji asset — ' +
            "this editor instance's premiumEmoji extension options were never configured with " +
            'one (see RichTextEditor.jsx\'s own PremiumEmojiNode.configure({botId, ...}) call). ' +
            'Falling back to the plain fallback character/text; no asset will be fetched.'
        );
      }
      setMeta(null);
      return undefined;
    }
    if (!id) {
      setMeta(null);
      return undefined;
    }
    lookupPremiumEmoji(botId, id).then((result) => {
      if (!canceled) setMeta(result);
    });
    return () => {
      canceled = true;
    };
  }, [botId, id]);

  return (
    <NodeViewWrapper as="span" className={`premium-emoji-node${selected ? ' is-selected' : ''}`}>
      {meta === undefined && <PremiumEmojiStatic botId={botId} customEmojiId={id} size={20} alt={fallback} />}
      {meta === null && <span className="premium-emoji-node__fallback-text">{fallback}</span>}
      {meta &&
        (readOnly ? (
          <PremiumEmojiStatic botId={botId} customEmojiId={id} size={20} alt={fallback} />
        ) : (
          <PremiumEmojiAnimated
            botId={botId}
            customEmojiId={id}
            isAnimated={meta.isAnimated}
            isVideo={meta.isVideo}
            size={20}
            alt={fallback}
          />
        ))}
    </NodeViewWrapper>
  );
}
