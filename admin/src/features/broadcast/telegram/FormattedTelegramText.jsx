import React from 'react';
import { parseRichHtmlToNodes } from '../../../components/richTextNodes.js';
import PremiumEmojiStatic from './PremiumEmojiStatic.jsx';
import useResolvedBotId from '../../../hooks/useResolvedBotId.js';

const TAG_ELEMENT = { b: 'b', i: 'i', u: 'u', s: 's' };

function renderNodes(nodes, keyPrefix, botId) {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}${i}`;
    if (node.type === 'text') return node.text; // plain string child — React escapes it automatically, never re-parsed
    // Prompt 0153 — rendered as PremiumEmojiStatic (a lazy thumbnail, never
    // an animation) deliberately: this component backs History/Recent
    // cards/Reschedule/Detail/View modal, several of which are real tables
    // that can list many rows at once — see PremiumEmojiAnimated's own
    // header on why mounting many live animations at once is exactly the
    // cost this avoids. Falls back to the plain fallback character
    // automatically (PremiumEmojiStatic's own `alt`/error-state handling)
    // when the asset can't be loaded, e.g. its pack was later removed.
    if (node.type === 'tg-emoji') {
      return <PremiumEmojiStatic key={key} botId={botId} customEmojiId={node.emojiId} size={18} alt={node.fallback} />;
    }
    if (node.tag === 'a') {
      return (
        <a key={key} href={node.href} target="_blank" rel="noopener noreferrer">
          {renderNodes(node.children, `${key}-`, botId)}
        </a>
      );
    }
    const Tag = TAG_ELEMENT[node.tag] || 'span';
    return <Tag key={key}>{renderNodes(node.children, `${key}-`, botId)}</Tag>;
  });
}

/**
 * Safely renders a stored title (or any other title_format-tagged field)
 * across every admin surface that displays one (History table, Recent
 * cards, View modal, Detail page — prompt 0149). Never
 * dangerouslySetInnerHTML: 'html'-format values are parsed via
 * parseRichHtmlToNodes (admin/src/components/richTextNodes.js — the parser
 * this component and FormattedRichText.jsx, the Announcements/Versions
 * equivalent, now BOTH build on; see that module's own header for the
 * prompt-0163-follow-up consolidation this replaced two independent
 * parser implementations with) into a strict node tree, then turned into
 * real React elements here — the browser's own HTML parser never sees the
 * raw string. 'plain'-format values render as a plain string child, which
 * React itself escapes automatically, so a legacy title containing literal
 * `<`/`>` characters displays exactly as typed rather than ever being
 * misread as markup.
 *
 * This component's own job is exactly the THIN layer richTextNodes.js's
 * own header describes: turn a `tg-emoji` node into a real premium-emoji
 * asset via PremiumEmojiStatic + a resolved botId (below) — everything else
 * (the actual b/i/u/s/a/tg-emoji parsing) lives in the shared module, not
 * here.
 *
 * Chosen over mounting a readOnly RichTextEditor (the ViewBroadcastModal
 * precedent already used for Message) for EVERY title-rendering surface,
 * including the modal — deliberately, not just for the per-row-cost table
 * cases: History can list many rows and Recent cards up to 12, where
 * mounting a real TipTap/ProseMirror instance per row is a real,
 * avoidable cost; using this same lightweight parser everywhere (rather
 * than TipTap-for-the-modal-but-parser-for-tables) keeps title rendering
 * as ONE mechanism to test and reason about, instead of two that could
 * silently drift apart.
 */
export default function FormattedTelegramText({ text, format, botId: botIdProp }) {
  // Prompt 0161 — resolved ONCE per render (not per tg-emoji node found in
  // the text) via useResolvedBotId(), so a title/body with several premium
  // emoji shares one resolution and, if genuinely missing, one dev warning
  // rather than one per node. This hook must run unconditionally (React's
  // own rules-of-hooks) even for the `format !== 'html'` early return below,
  // which never actually needs the result — a harmless, cheap context read.
  // Deliberate trade-off, not pinpointed further: this fires even for a
  // title/body that turns out to contain no `tg-emoji` node at all, once
  // there's genuinely no `botId` prop AND no `<DataBotProvider>` in the
  // tree — precisely gating it on "does this specific text contain a
  // premium emoji" would need parsing the text before deciding whether to
  // warn, which is more complexity than the actual failure mode (a caller
  // rendering this component with neither a prop nor any provider
  // installed at all — itself a real setup bug worth surfacing loudly
  // regardless of this particular text's own content) is worth chasing.
  const botId = useResolvedBotId(botIdProp, 'FormattedTelegramText');
  if (format !== 'html') return <>{text}</>;
  return <>{renderNodes(parseRichHtmlToNodes(text), 'n', botId)}</>;
}
