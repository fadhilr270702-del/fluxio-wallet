import React from 'react';
import { parseRichHtmlToNodes } from './richTextNodes.js';

const TAG_ELEMENT = { b: 'b', i: 'i', u: 'u', s: 's' };

function renderNodes(nodes, keyPrefix) {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}${i}`;
    if (node.type === 'text') return node.text; // plain string child — React escapes it automatically, never re-parsed
    // Prompt 0163 follow-up (consolidation) — richTextNodes.js's shared
    // parser recognizes `tg-emoji` (it has to, for FormattedTelegramText.jsx's
    // own sake), but Announcements/Versions have no botId/premium-emoji
    // concept at all and their own backend sanitizer never actually
    // produces this tag — this branch is the "other thin renderer"
    // richTextNodes.js's own header describes: a tg-emoji node here just
    // renders its plain fallback text, the same unwrap treatment any other
    // disallowed tag already gets, never a PremiumEmojiStatic import or a
    // botId resolution.
    if (node.type === 'tg-emoji') return node.fallback;
    if (node.tag === 'a') {
      return (
        <a key={key} href={node.href} target="_blank" rel="noopener noreferrer">
          {renderNodes(node.children, `${key}-`)}
        </a>
      );
    }
    const Tag = TAG_ELEMENT[node.tag] || 'span';
    return <Tag key={key}>{renderNodes(node.children, `${key}-`)}</Tag>;
  });
}

/**
 * Prompt 0163 — safely renders a stored Announcements title / Versions
 * update-message-style value wherever it needs to display outside the
 * editor itself (currently: AnnouncementTable's Title cell — see
 * AnnouncementForm.jsx's own header for why Body/Update message have no
 * separate read-only display surface today). Never dangerouslySetInnerHTML:
 * 'html'-format values are parsed via richTextNodes.js's shared
 * parseRichHtmlToNodes into a strict node tree, then turned into real React
 * elements here — the browser's own HTML parser never sees the raw string.
 * 'plain'-format values render as a plain string child, which React itself
 * escapes automatically, so a legacy value containing literal `<`/`>`
 * characters displays exactly as typed rather than ever being misread as
 * markup.
 *
 * Deliberately NOT FormattedTelegramText.jsx (the broadcast/Welcome
 * equivalent) — that component unconditionally calls useResolvedBotId(),
 * which would log a dev-only console.error on this page (no
 * <DataBotProvider> here, by design) even for text with no premium emoji
 * at all. This component has no botId concept whatsoever — it can't warn
 * about something it was never asked to resolve. As of the prompt-0163
 * follow-up consolidation, the two components share the exact same PARSER
 * (richTextNodes.js) — only this rendering layer differs (a tg-emoji node
 * unwraps to plain fallback text here, instead of a resolved
 * PremiumEmojiStatic asset), so there is no risk of the two ever
 * disagreeing on what counts as valid b/i/u/s/a/tg-emoji markup.
 */
export default function FormattedRichText({ text, format }) {
  if (format !== 'html') return <>{text}</>;
  return <>{renderNodes(parseRichHtmlToNodes(text), 'n')}</>;
}
