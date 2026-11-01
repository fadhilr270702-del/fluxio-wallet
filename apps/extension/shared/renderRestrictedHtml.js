/**
 * Prompt 0170 — builds real DOM nodes from richTextParse.js's own node
 * tree, for the notifications inbox's `'html'`-format title/body. Never
 * uses innerHTML/insertAdjacentHTML anywhere — every element is created
 * via document.createElement/createTextNode and appended, so there is no
 * step anywhere in this file where a string of server-provided text is
 * ever interpreted as markup.
 *
 * USES `document` — this file must NEVER be imported by background.js
 * (an MV3 service worker has no `document` global at all; importing this
 * there would throw at bundle-evaluation time). It is loaded only as a
 * plain unbundled ES module from popup/popup.js, same as every other
 * shared/*.js file that's popup-only. richTextParse.js itself stays free
 * of any DOM reference specifically so it can be imported from anywhere
 * (including a future background.js use, or a plain Vitest run) without
 * this constraint — see that file's own header comment.
 *
 * @param {HTMLElement} container - appended to directly; caller is
 *   responsible for clearing it first if re-rendering.
 * @param {Array} nodes - richTextParse.js's own parseRestrictedHtmlToNodes() output.
 */
export function renderRestrictedHtmlNodes(container, nodes) {
  nodes.forEach((node) => {
    if (node.type === 'text') {
      container.appendChild(document.createTextNode(node.text));
      return;
    }
    if (node.type === 'tag') {
      const el = document.createElement(node.tag);
      if (node.tag === 'a') {
        el.href = node.href;
        // Never trust an outbound link enough to hand it window.opener —
        // same noopener/noreferrer pattern this popup already uses for
        // every other externally-opened link (e.g. renderSendResult()'s
        // "View on Explorer").
        el.target = '_blank';
        el.rel = 'noopener noreferrer';
      }
      renderRestrictedHtmlNodes(el, node.children);
      container.appendChild(el);
    }
  });
}
