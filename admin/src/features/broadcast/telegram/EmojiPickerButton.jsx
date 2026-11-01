// Prompt 0159 — moved to `admin/src/components/EmojiPickerButton.jsx` once
// genuinely cross-feature callers existed (Announcements, Versions —
// neither anywhere near Telegram/Broadcast). Re-exported from its old path
// here so every existing Broadcast import (`ComposePage.jsx`,
// `WelcomePage.jsx`, `RichTextEditor.jsx`, `ButtonPremiumIconControl.jsx`)
// needed zero changes and Broadcast's own behavior stays byte-for-byte
// identical. See the new file's own header comment for the full move
// rationale.
export { default } from '../../../components/EmojiPickerButton.jsx';
