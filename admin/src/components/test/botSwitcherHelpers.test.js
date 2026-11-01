import { describe, it, expect } from 'vitest';
import { shouldConfirmBotSwitch, buildBotSwitchDialogContent } from '../botSwitcherHelpers.js';

describe('shouldConfirmBotSwitch', () => {
  it('never confirms when re-selecting the already-active bot, even if the form is dirty', () => {
    expect(shouldConfirmBotSwitch('test', 'test', true)).toBe(false);
    expect(shouldConfirmBotSwitch('official', 'official', true)).toBe(false);
  });

  it('confirms when switching to a different bot while the current form is dirty', () => {
    expect(shouldConfirmBotSwitch('test', 'official', true)).toBe(true);
    expect(shouldConfirmBotSwitch('official', 'test', true)).toBe(true);
  });

  it('switches immediately (no confirm) when switching to a different bot with a clean form', () => {
    expect(shouldConfirmBotSwitch('test', 'official', false)).toBe(false);
  });

  it('treats a falsy-but-non-boolean dirty signal (e.g. undefined from a page that never registered a check) as clean', () => {
    expect(shouldConfirmBotSwitch('test', 'official', undefined)).toBe(false);
    expect(shouldConfirmBotSwitch('test', 'official', null)).toBe(false);
  });
});

// Prompt 0142 — the switch-confirm dialog's own copy + which actions it
// offers, branched purely on whether the dirty page has a registered save
// action (Welcome does; Compose never does — a broadcast draft has no
// storage of its own).
describe('buildBotSwitchDialogContent', () => {
  it('offers Save when the dirty page has a registered save action', () => {
    const { canSave, message } = buildBotSwitchDialogContent({
      pageName: 'Welcome',
      targetLabel: 'Bot Resmi',
      hasSaveAction: true
    });
    expect(canSave).toBe(true);
    expect(message).toContain('Welcome');
    expect(message).toContain('Bot Resmi');
  });

  it('never offers Save when the dirty page has no registered save action', () => {
    const { canSave, message } = buildBotSwitchDialogContent({
      pageName: undefined,
      targetLabel: 'Bot Percobaan',
      hasSaveAction: false
    });
    expect(canSave).toBe(false);
    expect(message).toContain('tidak bisa disimpan');
    expect(message).toContain('Bot Percobaan');
  });

  it('names the target bot in both variants — the admin should always know where they are switching to', () => {
    const withSave = buildBotSwitchDialogContent({ pageName: 'Welcome', targetLabel: 'Bot Resmi', hasSaveAction: true });
    const withoutSave = buildBotSwitchDialogContent({ pageName: undefined, targetLabel: 'Bot Resmi', hasSaveAction: false });
    expect(withSave.message).toContain('Bot Resmi');
    expect(withoutSave.message).toContain('Bot Resmi');
  });

  it('the two variants read as genuinely distinct messages, never a generic shared label', () => {
    const withSave = buildBotSwitchDialogContent({ pageName: 'Welcome', targetLabel: 'Bot Resmi', hasSaveAction: true });
    const withoutSave = buildBotSwitchDialogContent({ pageName: undefined, targetLabel: 'Bot Resmi', hasSaveAction: false });
    expect(withSave.message).not.toBe(withoutSave.message);
  });
});
