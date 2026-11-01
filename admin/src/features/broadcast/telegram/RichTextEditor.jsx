import React, { useEffect, useMemo, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { DOMParser as PMDOMParser, DOMSerializer } from '@tiptap/pm/model';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import Icon from '../../../components/Icon.jsx';
import { splitPastedTextIntoLines } from './editorTelegramFormat.js';
import EmojiPickerButton from './EmojiPickerButton.jsx';
import PremiumEmojiNode from './premiumEmojiNode.js';
import useResolvedBotId from '../../../hooks/useResolvedBotId.js';

// Deliberately restricted extension set — this is what makes
// editorTelegramFormat.js's JSON walker tractable: only paragraphs, the 5
// requested marks, and (prompt 0153) the premiumEmoji inline atom node can
// ever exist in this editor's output (no headings/lists/blockquote/
// codeBlock/etc.). See CLAUDE.md's WYSIWYG composer slice for the full
// reasoning.
const BASE_EXTENSIONS = [
  StarterKit.configure({
    heading: false,
    bulletList: false,
    orderedList: false,
    listItem: false,
    listKeymap: false,
    blockquote: false,
    codeBlock: false,
    code: false,
    horizontalRule: false,
    link: {
      openOnClick: false,
      autolink: false,
      // Defense-in-depth against any programmatic/paste-triggered link
      // creation bypassing the toolbar's own explicit prompt below — the
      // toolbar's check (with a clear window.alert) is the primary UX,
      // this is the extension-level backstop.
      isAllowedUri: (url, ctx) => ctx.defaultValidate(url) && url.startsWith('https://')
    }
  })
];

/**
 * TipTap-backed rich text editor for the broadcast composer. `initialContent`
 * is read once at mount (TipTap's own pattern — this is intentionally an
 * uncontrolled component from React's perspective past that point); the
 * parent only ever mounts this once the correct starting HTML is already
 * known (ComposePage's loading-gate already ensures this for edit mode),
 * so no re-sync-after-mount logic is needed. `onChange(json)` fires on
 * every edit with `editor.getJSON()`.
 *
 * Prompt 0142 — the one-time mount-sync push below (see its own comment)
 * calls `onChange(json, { isInitialSync: true })` — a second, optional
 * argument real edits (via `onUpdate`) never pass — so a caller that needs
 * to tell the two apart (WelcomePage.jsx's own explicit `isDirty` flag,
 * unlike Compose's purely content-based dirty check) has a deterministic,
 * structural signal to check instead of racing a `setTimeout(0)` against
 * React's own commit/effect scheduling. That race was real, not
 * theoretical: a live headless-browser run of this exact page reproducibly
 * showed the `setTimeout(0)` firing and flipping a boolean suppression
 * flag back to "not suppressed" BEFORE this component's own mount effect
 * below ever ran, incorrectly marking a freshly-loaded, untouched Welcome
 * form as dirty every time.
 *
 * `readOnly` (prompt 0132 Revision 1) backs the new "View broadcast" modal.
 * This is deliberately NOT a second HTML-to-DOM renderer — it reuses this
 * exact same TipTap instance/extension set/schema, just with `editable:
 * false` and no toolbar, so a stored broadcast's body renders through the
 * identical parsing path "Edit isi" mode already trusts (ProseMirror's
 * schema-restricted HTML parser only recognizes <p>/<b>/<i>/<u>/<s>/<a
 * href> — anything else, e.g. a raw <script> tag or an event-handler
 * attribute smuggled into stored data, has no matching parse rule and is
 * therefore never turned into a live, attribute-bearing DOM node; the
 * safety of the "Edit isi" path applies equally here). `onChange` is
 * optional in this mode — nothing can be edited, so nothing to report up.
 *
 * `singleLine` (prompt 0149) backs the Title field in ComposePage, which
 * needs the exact same mark/link/emoji toolbar as Message but must always
 * stay one line: Enter/Shift+Enter are consumed (never split the block),
 * a plain-text paste is joined with spaces instead of one `<p>` per line,
 * and — the actual invariant-enforcing backstop, not just "the common
 * paths are covered" — a ProseMirror `appendTransaction` plugin merges the
 * doc back down to exactly one paragraph (space-joining any extra ones,
 * preserving each run's own marks) whenever ANYTHING results in more than
 * one, including paths neither of the first two mechanisms can pre-empt
 * (an HTML-carrying paste with its own multiple `<p>`/block elements, which
 * ProseMirror's own default HTML-to-doc parser maps onto this schema's
 * only block type — paragraph — one per source block; or any other future
 * input path that isn't a plain keypress or a plain-text paste). This is
 * deliberately a real ProseMirror plugin (via `Extension.create()`,
 * `@tiptap/core`) rather than trying to special-case every possible input
 * path individually — the guarantee holds regardless of how a second
 * paragraph would otherwise have gotten there.
 */
const SingleLineGuard = Extension.create({
  name: 'singleLineGuard',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const { doc, schema } = newState;
          if (doc.childCount <= 1) return null;
          // Flatten every top-level paragraph's own inline content into one,
          // inserting a plain space (no marks) between what used to be
          // separate paragraphs — matches the same "space-joined" merge
          // clipboardTextParser below already does for a plain-text paste,
          // so both mechanisms produce visually consistent results.
          const pieces = [];
          doc.forEach((node, _offset, index) => {
            if (index > 0) pieces.push(schema.text(' '));
            node.forEach((child) => pieces.push(child));
          });
          const mergedParagraph = schema.nodes.paragraph.create(null, pieces);
          const tr = newState.tr.replaceWith(0, doc.content.size, mergedParagraph);
          // Keeps the cursor at the end of the merged content rather than
          // wherever ProseMirror's own default mapping would leave it after
          // a whole-document replace — the common case triggering this (a
          // multi-block paste) should land the caret right after what was
          // just pasted, not somewhere in the middle.
          return tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1));
        }
      })
    ];
  }
});

export default function RichTextEditor({
  initialContent,
  onChange,
  readOnly = false,
  singleLine = false,
  botId: botIdProp = null,
  // Prompt 0163 — default true, so every existing broadcast/Welcome call
  // site (which never passes this prop at all) is completely unaffected.
  // Announcements/Versions pass `premiumEnabled={false}`: neither is a
  // Telegram concept, so the premiumEmoji node, the Premium picker tab, and
  // any botId resolution/warning simply don't apply — see below and the
  // extensions useMemo's own comment for exactly what changes.
  premiumEnabled = true
}) {
  // Prompt 0161 — resolved via useResolvedBotId() (explicit prop still
  // wins over the ambient <DataBotProvider>, per that hook's own
  // contract) instead of trusted as directly given. Deliberately kept as
  // extension.options.botId below rather than having PremiumEmojiNodeView
  // read context directly — that node view is rendered through TipTap's
  // own ReactNodeViewRenderer bridge, not a plain nested component. 0161
  // itself avoided betting on whether context propagates through that
  // bridge; prompt 0162 actually checked, live, by reading DataBotContext
  // directly inside a temporary instrumented NodeView and switching bots
  // client-side with no page reload — the NodeView never re-rendered at
  // all, confirming ReactNodeViewRenderer mounts each node view as its own
  // React root, disconnected from the surrounding app's context tree.
  // Context is therefore NOT an option here, proven rather than assumed;
  // extension.options stays the only channel.
  //
  // Prompt 0163 — `{ silent: !premiumEnabled }` makes this call a genuine
  // no-op (returns null, no context resolution, no dev console.error) when
  // premium is disabled, WITHOUT skipping the hook call itself (still
  // called unconditionally on every render, satisfying React's rules of
  // hooks) — see useResolvedBotId.js's own header for why varying its
  // internal behavior via an argument is the safe way to do this, not
  // conditionally calling the hook based on a prop.
  const botId = useResolvedBotId(botIdProp, 'RichTextEditor', { silent: !premiumEnabled });

  // Prompt 0162 regression + fix — the paragraph below (kept from 0153/0161
  // for the historical "why useMemo" reasoning) was WRONG about one thing:
  // `botId` very much CAN change after mount in practice, whenever the bot
  // switcher is used without leaving Compose/Welcome (DataBotContext's
  // value updates, useResolvedBotId re-renders with a new botId, this
  // useMemo correctly recomputes a new `extensions` array) — that part
  // always worked. What didn't: TipTap's own `useEditor(options)` with no
  // second `deps` argument only ever calls `editor.setOptions({...})` on a
  // changed `extensions` array, and `Editor.setOptions()` (read directly
  // from node_modules/@tiptap/core) only merges `this.options` and pokes
  // the ProseMirror view's props/state — it never rebuilds
  // `this.extensionManager`, which is what actually supplies the
  // `nodeViews` factory ProseMirror calls to construct a NodeView for a
  // newly-inserted `premiumEmoji` node. So a NodeView created after a bot
  // switch still received the OLD extension instance's `.options.botId`,
  // frozen from whenever the CURRENT editor instance was originally
  // created — confirmed with a live trace (temporary console.log probes,
  // since removed): after a client-side switch to `official` with no
  // reload, `extensions useMemo` correctly recomputed to `botId=official`,
  // yet the very next inserted emoji's NodeView still read
  // `extension.options.botId=test`. "Salin ke form" masked this because it
  // bumps `editorKey` on ComposePage, fully remounting RichTextEditor (and
  // therefore the whole TipTap editor) from scratch with the by-then
  // already-correct botId.
  //
  // Fix: extensions array must stay referentially stable across re-renders
  // of the SAME editor instance (TipTap/ProseMirror both key internal
  // state off it), so this is computed via useMemo, not a fresh array
  // literal every render — but `botId` is now explicitly passed as
  // useEditor's own `deps` array below, which (per @tiptap/react's own
  // useEditor implementation) takes an entirely different, correct path
  // for a real prop-driven change: destroy the old editor and construct a
  // brand new one, whose `nodeViews` factory is rebuilt from scratch
  // against the current (correct) extensions — the only mechanism that
  // actually reaches NodeView construction. `singleLine`/`readOnly` are
  // deliberately NOT in that deps array — matching the original comment's
  // still-true observation that each call site fixes those for the
  // instance's whole lifetime, so forcing a recreate for them would be
  // needless churn/risk with no real bug behind it.
  // Prompt 0163 — when premiumEnabled is false, PremiumEmojiNode is left
  // out of the extensions array entirely: the `premiumEmoji` node type
  // genuinely does not exist in this editor instance's schema at all (not
  // just "configured with a null botId"), matching the base prompt's own
  // explicit "node premiumEmoji tidak diaktifkan" requirement. A stray
  // `<tg-emoji>` in initialContent (never actually produced for
  // Announcements/Versions — their own backend sanitizer never allows that
  // tag through, see backend/src/utils/richHtml.js) would simply be
  // unrecognized by ProseMirror's HTML parser and dropped, the same
  // "unknown tag" handling any other disallowed tag already gets.
  const extensions = useMemo(() => {
    const base = premiumEnabled ? [...BASE_EXTENSIONS, PremiumEmojiNode.configure({ botId, readOnly })] : [...BASE_EXTENSIONS];
    return singleLine ? [...base, SingleLineGuard] : base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singleLine, botId, readOnly, premiumEnabled]);

  // Recreating the editor on a botId change would otherwise reset its
  // content back to whatever `initialContent` was at the ORIGINAL mount —
  // silently discarding anything the admin typed in between (exactly the
  // content-loss risk flagged by this prompt's own instructions). Tracked
  // here, updated on every real edit (onUpdate below), and always fed to
  // useEditor as `content` instead of the raw `initialContent` prop — on
  // first mount it's identical to `initialContent` (the ref's own initial
  // value), and by the time any later botId-triggered recreate happens it
  // reflects the actual current document.
  const liveContentRef = useRef(initialContent);

  const editor = useEditor({
    extensions,
    content: liveContentRef.current,
    editable: !readOnly,
    // Prompt 0146 Bug 2 fix — TipTap v3 defaults this component to NOT
    // re-render on every editor transaction (a v2->v3 perf change; see
    // useEditor's own `shouldRerenderOnTransaction` option), only on
    // `onUpdate`-triggered ones (i.e. an actual document content change).
    // Clicking Bold/Italic/Underline/Strike on a collapsed cursor toggles
    // `storedMarks` — a real state change with no doc content change — so
    // without this flag the toolbar's `editor.isActive(...)`-driven
    // `is-active` indicator below goes stale: verified live that the
    // underlying toggle always worked correctly (mixed bold/non-bold text
    // sent correctly every time), it was only the button's own visual
    // state that failed to refresh until the next keystroke.
    shouldRerenderOnTransaction: true,
    editorProps: {
      // Prompt 0149 — Enter (and Shift+Enter, StarterKit's own "insert a
      // hard line break instead" binding) are consumed outright in
      // singleLine mode, returning `true` to tell ProseMirror the key was
      // handled so its default splitBlock/hardBreak commands never run.
      // This is the PRIMARY mechanism for typed input; the
      // appendTransaction guard above (SingleLineGuard) is what still
      // catches paste and any other path this can't intercept.
      handleKeyDown(view, event) {
        if (singleLine && event.key === 'Enter') return true;
        return false;
      },
      // Prompt 0146 Bug 1 fix — see splitPastedTextIntoLines's own comment
      // (editorTelegramFormat.js) for the confirmed root cause. Only
      // overrides plain-text-only paste; an HTML clipboard payload already
      // parses correctly via ProseMirror's ordinary DOM parser (and, in
      // singleLine mode, is then merged back to one paragraph by
      // SingleLineGuard's own appendTransaction, since a multi-block HTML
      // paste isn't something this text-only parser ever sees).
      //
      // Prompt 0149 — in singleLine mode, every line from a plain-text
      // paste is joined with a single space into ONE paragraph instead of
      // one `<p>` per line — matches the base prompt's own explicit
      // "paste multi-baris digabung jadi satu baris (spasi sebagai
      // pemisah)" requirement, and keeps the doc single-paragraph from the
      // paste itself rather than relying solely on the appendTransaction
      // backstop to fix it up afterward.
      clipboardTextParser(text, $context, plainText, view) {
        const { schema } = view.state;
        const serializer = DOMSerializer.fromSchema(schema);
        const marks = $context.marks();
        const dom = document.createElement('div');
        const lines = splitPastedTextIntoLines(text);
        if (singleLine) {
          const p = dom.appendChild(document.createElement('p'));
          const joined = lines.join(' ').trim();
          if (joined) p.appendChild(serializer.serializeNode(schema.text(joined, marks)));
        } else {
          lines.forEach((line) => {
            const p = dom.appendChild(document.createElement('p'));
            if (line) p.appendChild(serializer.serializeNode(schema.text(line, marks)));
          });
        }
        const parser = view.someProp('clipboardParser') || view.someProp('domParser') || PMDOMParser.fromSchema(schema);
        return parser.parseSlice(dom, { preserveWhitespace: true, context: $context });
      }
    },
    // Prompt 0162 — also mirrors the live doc into liveContentRef (see its
    // own comment above) on every real edit, so a later botId-triggered
    // recreate seeds the new editor from the current content, not the
    // original mount-time initialContent.
    onUpdate: readOnly
      ? undefined
      : ({ editor: e }) => {
          const json = e.getJSON();
          liveContentRef.current = json;
          onChange(json);
        }
  }, [botId]);

  // onUpdate only fires on user edits — without this, submitting without
  // ever touching a pre-filled editor (e.g. "Edit isi", changing only the
  // title) would leave the parent's doc state stuck at its initial value.
  // Pushing the doc up once as soon as the editor exists keeps the parent
  // always in sync, whether the content came pre-seeded or empty. Skipped
  // entirely in readOnly mode — there's no parent doc state to sync.
  //
  // Prompt 0162 — this also fires again whenever `editor` changes identity
  // due to a botId-triggered recreate (see above), re-pushing the
  // preserved content up as another isInitialSync call — harmless/
  // idempotent (the parent already holds this exact content; WelcomePage's
  // own isDirty tracking already treats isInitialSync as a no-op, per its
  // own comment), and correctly does NOT mark a bot switch as a content
  // edit.
  useEffect(() => {
    if (editor && !readOnly) onChange(editor.getJSON(), { isInitialSync: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  function handleLink() {
    if (!editor) return;
    const previousUrl = editor.getAttributes('link').href || '';
    const input = window.prompt('Link URL (must start with https://):', previousUrl);
    if (input === null) return; // canceled
    const url = input.trim();
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    if (!url.startsWith('https://')) {
      window.alert('Link URL must start with https://');
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }

  if (!editor) return null;

  const btn = (name, label, onClick, active) => (
    <button
      type="button"
      className={`rich-text-editor__btn${active ? ' is-active' : ''}`}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      {name}
    </button>
  );

  return (
    <div className={`rich-text-editor${readOnly ? ' rich-text-editor--readonly' : ''}${singleLine ? ' rich-text-editor--single-line' : ''}`}>
      {!readOnly && (
        <div className="rich-text-editor__toolbar">
          {btn(<b>B</b>, 'Bold', () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'))}
          {btn(<i>I</i>, 'Italic', () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'))}
          {btn(<u>U</u>, 'Underline', () => editor.chain().focus().toggleUnderline().run(), editor.isActive('underline'))}
          {btn(<s>S</s>, 'Strikethrough', () => editor.chain().focus().toggleStrike().run(), editor.isActive('strike'))}
          {btn(<Icon name="link" />, 'Link', handleLink, editor.isActive('link'))}
          {/* Prompt 0147 — inserts at the cursor via TipTap's own chain, so
              whatever mark is currently active (bold/italic/...) stays
              active for text typed right after the emoji, same as typing
              the emoji character directly would. Not part of the `btn()`
              helper above since it owns its own popover, not a plain
              click handler. */}
          {/* Prompt 0163 — showPremiumTab/onSelectPremium are only passed
              when premiumEnabled: omitting them entirely (rather than
              passing showPremiumTab={false}) matches
              EmojiPickerButton.jsx's own default state, already proven
              (prompt 0159's own investigation) to render Standard-tab-only
              with zero /admin/emoji-packs fetch — the exact behavior
              Announcements/Versions need, with no new prop/branch invented
              in EmojiPickerButton itself. Inserting a premiumEmoji node
              when the extension isn't even registered (premiumEnabled
              false) would be unreachable anyway, since onSelectPremium is
              never passed down for the picker to call. */}
          <EmojiPickerButton
            className="rich-text-editor__btn"
            ariaLabel="Insert emoji"
            onSelect={(emojiNative) => editor.chain().focus().insertContent(emojiNative).run()}
            {...(premiumEnabled
              ? {
                  showPremiumTab: true,
                  onSelectPremium: ({ customEmojiId, fallbackEmoji }) =>
                    editor
                      .chain()
                      .focus()
                      .insertContent({ type: 'premiumEmoji', attrs: { id: customEmojiId, fallback: fallbackEmoji } })
                      .run()
                }
              : {})}
          />
        </div>
      )}
      <EditorContent editor={editor} className="rich-text-editor__content" />
    </div>
  );
}
