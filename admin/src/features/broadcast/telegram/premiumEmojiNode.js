import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import PremiumEmojiNodeView from './PremiumEmojiNodeView.jsx';

/**
 * Prompt 0153 — the inline atom node backing a premium (Telegram custom)
 * emoji inserted into Title or Message. Attrs are deliberately minimal —
 * `id` (the custom_emoji_id) and `fallback` (the plain emoji character
 * shown wherever Telegram can't render the real thing) — because those two
 * are ALL `<tg-emoji emoji-id="ID">fallback</tg-emoji>` itself carries; any
 * richer metadata this node's own NodeView needs to actually render an
 * animation (is it Lottie or WEBM?) is resolved separately, live, via the
 * new `GET /admin/emoji-packs/lookup/:botId/:customEmojiId` endpoint (see
 * PremiumEmojiNodeView.jsx) — never stored on the node itself, since a
 * round-tripped `<tg-emoji>` loaded from "Edit isi"/"Salin ke form"/Welcome
 * never carries that information either.
 *
 * `atom: true` (a leaf with no editable inner content) is what makes
 * Backspace delete the whole node in one keystroke, like a single
 * character — the default ProseMirror atom-node behavior, no custom
 * keymap needed. Copy/paste preserving `id`/`fallback` is likewise the
 * default outcome of a real parseHTML/renderHTML pair (ProseMirror
 * serializes a selection through renderHTML, then re-parses the resulting
 * HTML through parseHTML on paste) — nothing extra required for either of
 * the base prompt's own explicit requirements here.
 *
 * `botId`/`readOnly` are extension-level options (`.configure({...})`),
 * not node attrs — every premiumEmoji node in one editor instance always
 * shares the same active bot and the same read-only-ness, so there's no
 * reason to duplicate those onto every single node.
 */
const PremiumEmojiNode = Node.create({
  name: 'premiumEmoji',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { botId: null, readOnly: false };
  },

  addAttributes() {
    return {
      id: { default: null },
      fallback: { default: '' }
    };
  },

  parseHTML() {
    return [
      {
        tag: 'tg-emoji[emoji-id]',
        getAttrs: (dom) => ({
          id: dom.getAttribute('emoji-id'),
          fallback: dom.textContent || ''
        })
      }
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['tg-emoji', mergeAttributes({ 'emoji-id': node.attrs.id }, HTMLAttributes), node.attrs.fallback];
  },

  addNodeView() {
    return ReactNodeViewRenderer(PremiumEmojiNodeView);
  }
});

export default PremiumEmojiNode;
