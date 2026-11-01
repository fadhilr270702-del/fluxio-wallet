// Prompt 0163 — this module moved to admin/src/components/editorTelegramFormat.js
// once it became genuinely shared beyond broadcast/Welcome (Announcements'
// Title/Body and Versions' Update message now use it too — see that file's
// own header). Re-exported here unchanged so every existing import in this
// folder (ComposePage.jsx, WelcomePage.jsx, RichTextEditor.jsx,
// BroadcastDetailPage.jsx, ViewBroadcastModal.jsx, WelcomeVersionViewModal.jsx,
// composeRecentCards.js, test/editorTelegramFormat.test.js) needed zero
// changes — same "move + re-export shim at the old path" pattern prompt
// 0159 already used for EmojiPickerButton.jsx/cursorInsert.js/eventPath.js.
export * from '../../../components/editorTelegramFormat.js';
