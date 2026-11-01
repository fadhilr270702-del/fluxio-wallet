import React from 'react';
import EmojiPickerButton from './EmojiPickerButton.jsx';
import PremiumEmojiStatic from './PremiumEmojiStatic.jsx';
import Icon from '../../../components/Icon.jsx';

/**
 * Prompt 0153 — the small "premium icon" control on one button row
 * (Compose AND Welcome, identical either place). The button's own text
 * label stays a plain string field, unchanged — this only ever sets/clears
 * `icon_custom_emoji_id` (Telegram Bot API 9.4's InlineKeyboardButton
 * field), a completely separate concern from the label.
 *
 * `EmojiPickerButton`'s `premiumOnly` mode is what makes this open
 * straight into the Premium tab's own grid — no Standard emoji-mart tab
 * makes sense here, since this picks a custom_emoji_id, never text.
 *
 * Prompt 0161 — no longer takes a `botId` prop: it was a pure relay to
 * its two nested components (`PremiumEmojiStatic`, `EmojiPickerButton`),
 * neither of which needs it passed explicitly anymore — both resolve via
 * `<DataBotProvider>` on their own. Every existing caller (ComposePage,
 * WelcomePage) already renders its button rows inside the correct
 * provider, so this changed nothing about what either page shows.
 */
export default function ButtonPremiumIconControl({ iconCustomEmojiId, onSelect, onRemove, ariaLabelPrefix }) {
  if (iconCustomEmojiId) {
    return (
      <div className="button-rows__icon-control">
        <PremiumEmojiStatic customEmojiId={iconCustomEmojiId} size={20} alt="" />
        <button
          type="button"
          className="icon-btn"
          aria-label={`${ariaLabelPrefix} — remove premium icon`}
          onClick={onRemove}
        >
          <Icon name="trash" />
        </button>
      </div>
    );
  }
  return (
    <div className="button-rows__icon-control">
      <EmojiPickerButton
        ariaLabel={`${ariaLabelPrefix} — premium icon`}
        className="icon-btn"
        premiumOnly
        onSelectPremium={({ customEmojiId }) => onSelect(customEmojiId)}
      />
      <span className="field-hint">Premium icon</span>
    </div>
  );
}
