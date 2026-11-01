// Prompt 0159 — moved to `admin/src/components/cursorInsert.js` alongside
// `EmojiPickerButton.jsx` once genuinely cross-feature callers existed.
// Re-exported from its old path here so `ComposePage.jsx`/`WelcomePage.jsx`
// needed zero import changes.
export { insertAtCursor } from '../../../components/cursorInsert.js';
