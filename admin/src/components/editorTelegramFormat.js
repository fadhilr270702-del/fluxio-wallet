/**
 * Converts between the rich-text editor's TipTap document and a restricted
 * HTML subset (<b><i><u><s><a href="https://...">). This walks TipTap's own
 * structured JSON (editor.getJSON()), never raw HTML — the editor's
 * extension set is deliberately restricted (see RichTextEditor.jsx's
 * StarterKit config: no headings/lists/blockquote/codeBlock/etc.), so the
 * JSON tree can only ever contain paragraphs, text nodes, and the 5
 * supported marks (plus, when RichTextEditor's `premiumEnabled` is true, a
 * premiumEmoji node — see renderPremiumEmojiNode below). There's no
 * "arbitrary HTML" attack surface to sanitize against here — the backend
 * still independently re-validates/sanitizes everything it receives (see
 * backend/src/telegram/formatting.js for broadcasts/Welcome,
 * backend/src/utils/richHtml.js for Announcements/Versions), since a client
 * is never trusted just because it's the browser.
 *
 * Prompt 0163 — moved here from
 * admin/src/features/broadcast/telegram/editorTelegramFormat.js (which now
 * just re-exports this file's own exports, so every existing broadcast/
 * Welcome import needed zero changes — same "move + re-export shim at the
 * old path" pattern prompt 0159 already used for EmojiPickerButton.jsx/
 * cursorInsert.js/eventPath.js) once this module became genuinely shared:
 * Announcements' Title/Body and each platform's Update message now also
 * serialize through editorJsonToTelegramHtml()/editorJsonToTelegramTitleHtml()
 * and round-trip through bodyToEditorHtml()/titleToEditorHtml(), the exact
 * same functions broadcasts/Welcome already used — "one renderer, reused
 * everywhere", per that prompt's own explicit instruction. Nothing in this
 * file changed behaviorally; renderPremiumEmojiNode/INLINE_NODE_TYPES's
 * 'premiumEmoji' handling stays fully generic and harmless for a caller
 * whose editor never has that node type registered at all (RichTextEditor's
 * own premiumEnabled={false} mode) — a doc from that editor simply never
 * contains a 'premiumEmoji'-typed node to match.
 */

/** Escapes a plain string for safe embedding in Telegram HTML (order matters — & first). */
export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Wraps an already-escaped inner HTML string with whatever marks apply —
 * shared by both a plain text run and a premiumEmoji node (prompt 0153),
 * since a premium emoji can carry the same bold/italic/etc. marks a text
 * run can (e.g. a user selects "bold text 🎉 more text" including the
 * emoji and hits Bold). Fixed nesting order (innermost to outermost) so
 * tags are always balanced regardless of which marks are combined: link,
 * strike, underline, italic, bold.
 */
function wrapWithMarks(html, marks) {
  const byType = {};
  for (const mark of marks || []) byType[mark.type] = mark;
  let result = html;
  if (byType.link) {
    const href = escapeHtml(byType.link.attrs?.href || '');
    result = `<a href="${href}">${result}</a>`;
  }
  if (byType.strike) result = `<s>${result}</s>`;
  if (byType.underline) result = `<u>${result}</u>`;
  if (byType.italic) result = `<i>${result}</i>`;
  if (byType.bold) result = `<b>${result}</b>`;
  return result;
}

function renderTextNode(node) {
  return wrapWithMarks(escapeHtml(node.text || ''), node.marks);
}

/**
 * Prompt 0153 — a premiumEmoji node (see premiumEmojiNode.js) serializes to
 * exactly the `<tg-emoji emoji-id="...">fallback</tg-emoji>` shape
 * Telegram's Bot API 9.4 expects (verified live in prompt 0151's own
 * spike) — `fallback` is escaped the same way plain text is (defense in
 * depth; a fallback is always a plain emoji character in practice, never
 * containing `<`/`>`/`&`, but this makes no assumption about that).
 */
function renderPremiumEmojiNode(node) {
  const html = `<tg-emoji emoji-id="${escapeHtml(node.attrs?.id || '')}">${escapeHtml(node.attrs?.fallback || '')}</tg-emoji>`;
  return wrapWithMarks(html, node.marks);
}

function renderInlineNode(node) {
  if (node.type === 'premiumEmoji') return renderPremiumEmojiNode(node);
  return renderTextNode(node);
}

const INLINE_NODE_TYPES = new Set(['text', 'premiumEmoji']);

function renderParagraph(node) {
  if (!node.content || node.content.length === 0) return '';
  return node.content
    .filter((child) => INLINE_NODE_TYPES.has(child.type))
    .map(renderInlineNode)
    .join('');
}

/**
 * doc = editor.getJSON(). Each top-level paragraph becomes one line,
 * joined by a single \n (matches the old textarea's line-break behavior —
 * not \n\n, no visual paragraph gap in the sent message).
 */
export function editorJsonToTelegramHtml(doc) {
  const paragraphs = (doc?.content || []).filter((node) => node.type === 'paragraph');
  return paragraphs.map(renderParagraph).join('\n');
}

/**
 * Walks the same JSON for every `link` mark and checks its href — mirrors
 * validateButtons()'s pattern/wording exactly (same rule: non-empty, must
 * start with https://). Returns a clear error string, or null if every
 * link is valid. Call before editorJsonToTelegramHtml() at submit time —
 * this is the authoritative re-check backing the editor's own immediate
 * (isAllowedUri-based) feedback when a link is inserted.
 */
export function validateEditorLinks(doc) {
  let error = null;
  function walk(node) {
    if (error || !node) return;
    for (const mark of node.marks || []) {
      if (mark.type !== 'link') continue;
      const href = (mark.attrs?.href || '').trim();
      if (!href) {
        error = 'One of the links in the message is missing a URL.';
      } else if (!href.startsWith('https://')) {
        error = 'One of the links in the message must start with https://';
      }
      if (error) return;
    }
    (node.content || []).forEach(walk);
  }
  walk(doc);
  return error;
}

/** True if the document has no visible text at all (submit-time "message is required" check). */
export function isEditorDocEmpty(doc) {
  return editorJsonToTelegramHtml(doc).trim().length === 0;
}

/**
 * Prompt 0153 — a premiumEmoji node counts as exactly its `fallback`
 * text's own length, matching how Telegram itself measures a `<tg-emoji>`
 * (see backend/src/telegram/formatting.js's stripToPlainText — a tag is
 * stripped down to its own text content, no special-casing needed there
 * since the tag-stripping regex is already generic; this is the
 * client-side mirror of that same measurement).
 */
function paragraphPlainText(node) {
  if (!node.content || node.content.length === 0) return '';
  return node.content
    .filter((child) => INLINE_NODE_TYPES.has(child.type))
    .map((child) => (child.type === 'premiumEmoji' ? child.attrs?.fallback || '' : child.text || ''))
    .join('');
}

/**
 * Raw visible-character count of the message, ignoring marks entirely
 * (bold/italic/etc. don't add characters) — mirrors the backend's
 * plainTextLength(), used client-side for the same "caption must be at
 * most 1024 chars when an image is attached" check, before ever hitting
 * the network. Simpler than the HTML walker since there's no tag/escaping
 * concern here, just the raw text a reader would actually see.
 */
export function editorPlainTextLength(doc) {
  const paragraphs = (doc?.content || []).filter((node) => node.type === 'paragraph');
  return paragraphs.map(paragraphPlainText).join('\n').length;
}

/**
 * The reverse direction, for "Edit isi": turns a stored body back into
 * HTML the editor's setContent() can load.
 *  - bodyFormat 'html': body is already safe restricted HTML — just needs
 *    its \n line breaks turned back into <p> boundaries.
 *  - bodyFormat 'plain' (legacy rows, or none supplied): body is raw
 *    text that may contain literal <, >, & — HTML-escaped first, so it
 *    displays correctly as plain text in the editor rather than being
 *    misread as markup.
 */
export function bodyToEditorHtml(body, bodyFormat = 'plain') {
  const safeInner = bodyFormat === 'html' ? (body || '') : escapeHtml(body || '');
  return safeInner
    .split('\n')
    .map((line) => `<p>${line}</p>`)
    .join('');
}

/**
 * Renders a title document (from RichTextEditor's `singleLine` mode) to
 * restricted HTML — always exactly ONE line, never `\n`, regardless of how
 * many paragraphs the doc actually has. A well-formed singleLine doc only
 * ever has one paragraph (Enter is consumed, paste is merged — see
 * RichTextEditor.jsx's own SingleLineGuard), so this is defensive, not
 * load-bearing for the normal case: if that invariant were ever violated,
 * joining with a single space (rather than editorJsonToTelegramHtml's own
 * `\n`) guarantees a title can never accidentally introduce a line break
 * into the combined title+body message a consumer receives.
 */
export function editorJsonToTelegramTitleHtml(doc) {
  const paragraphs = (doc?.content || []).filter((node) => node.type === 'paragraph');
  return paragraphs.map(renderParagraph).join(' ').trim();
}

/** Same "no visible text" check as isEditorDocEmpty, for a title doc. */
export function isEditorTitleEmpty(doc) {
  return editorJsonToTelegramTitleHtml(doc).trim().length === 0;
}

/**
 * The reverse direction for title, mirroring bodyToEditorHtml exactly
 * (same 'html'-passthrough / 'plain'-escape split) — the only difference
 * is there's no `\n`-per-paragraph splitting to do, since a title is
 * always a single line/paragraph by construction. Used by "Edit isi" and
 * "Salin ke form" to seed the Title singleLine editor from a stored
 * title/titleFormat pair, the same way bodyToEditorHtml seeds Message.
 */
export function titleToEditorHtml(title, titleFormat = 'plain') {
  const safeInner = titleFormat === 'html' ? (title || '') : escapeHtml(title || '');
  return `<p>${safeInner}</p>`;
}

/**
 * Splits raw pasted plain text into one entry per intended paragraph,
 * preserving blank lines — an empty string entry for each one — the exact
 * same convention bodyToEditorHtml's own `.split('\n')` above already uses.
 * The only caller is RichTextEditor.jsx's `clipboardTextParser` editor
 * prop, added to fix prompt 0146's Bug 1.
 *
 * Root cause (confirmed live, not just theorized): typing Enter twice
 * already worked correctly the whole time — a manually-typed blank line
 * round-trips through save/reload and sends to Telegram with a real gap,
 * verified against the actual running admin+backend. The bug only hits
 * PASTED text, because ProseMirror's own built-in plain-text clipboard
 * parser (prosemirror-view's `parseFromClipboard`) splits on
 * `/(?:\r\n?|\n)+/` — note the `+` — which treats ANY run of one or more
 * consecutive newlines as a SINGLE paragraph separator, silently
 * discarding every blank line in between. An admin who drafts a message
 * elsewhere (Notepad, a doc, the CWS listing text, ...) with blank lines
 * between paragraphs and pastes it here loses every one of those blank
 * lines before the message is ever saved — reproduced directly by
 * dispatching a real `paste` ClipboardEvent with `\r\n\r\n`-separated
 * plain text and inspecting the resulting doc. This function splits on a
 * SINGLE newline instead, so a blank line becomes a genuinely empty
 * paragraph — the same structure a manual double-Enter keypress already
 * produces correctly.
 *
 * Only affects plain-text-only paste (no HTML clipboard data, or an
 * explicit "paste as plain text") — ProseMirror only ever calls
 * `clipboardTextParser` in that case. A paste that DOES carry HTML (e.g.
 * from another rich text editor) goes through ProseMirror's ordinary DOM
 * parser instead, which already recognizes a genuine empty `<p></p>` as a
 * blank line — the same mechanism bodyToEditorHtml's own generated HTML
 * already relies on — so that path needs no separate fix.
 */
export function splitPastedTextIntoLines(text) {
  return String(text ?? '').split(/\r\n?|\n/);
}
