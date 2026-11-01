import { describe, it, expect } from 'vitest';
import { isSendGuardRequired, buildSendGuardMessage } from '../sendGuard.js';

describe('isSendGuardRequired', () => {
  it('requires the guard for a new (create-mode) submission on the official bot', () => {
    expect(isSendGuardRequired('official', false)).toBe(true);
  });

  it('never requires the guard on the trial bot, regardless of edit mode', () => {
    expect(isSendGuardRequired('test', false)).toBe(false);
    expect(isSendGuardRequired('test', true)).toBe(false);
  });

  it('never requires the guard while editing an existing broadcast, even on the official bot', () => {
    expect(isSendGuardRequired('official', true)).toBe(false);
  });
});

describe('buildSendGuardMessage', () => {
  it('names the real bot username and subscriber count for a subscribers-target immediate send', () => {
    const message = buildSendGuardMessage({
      botUsername: 'FluxioWallet_bot',
      targetType: 'subscribers',
      targetChannelId: '',
      activeSubscriberCount: 3,
      isRecurring: false
    });
    expect(message).toBe('Kirim via @FluxioWallet_bot ke 3 subscriber?');
  });

  it('names the channel id for a channel-target send', () => {
    const message = buildSendGuardMessage({
      botUsername: 'FluxioWallet_bot',
      targetType: 'channel',
      targetChannelId: '@fluxio_announcements',
      activeSubscriberCount: 0,
      isRecurring: false
    });
    expect(message).toBe('Kirim via @FluxioWallet_bot ke @fluxio_announcements?');
  });

  it('uses the recurring-activation wording naming the interval when isRecurring is true, "sekarang" when no start time was chosen', () => {
    const message = buildSendGuardMessage({
      botUsername: 'FluxioWallet_bot',
      targetType: 'subscribers',
      targetChannelId: '',
      activeSubscriberCount: 5,
      isRecurring: true,
      recurringIntervalHours: 3,
      recurringStartsAt: null
    });
    expect(message).toBe('Aktifkan pengiriman setiap 3 jam mulai sekarang via @FluxioWallet_bot ke 5 subscriber?');
  });

  it('names the actual chosen start time when recurringStartsAt is set', () => {
    const message = buildSendGuardMessage({
      botUsername: 'FluxioWallet_bot',
      targetType: 'subscribers',
      targetChannelId: '',
      activeSubscriberCount: 5,
      isRecurring: true,
      recurringIntervalHours: 2,
      recurringStartsAt: '2026-08-31T10:00:00.000Z'
    });
    expect(message.startsWith('Aktifkan pengiriman setiap 2 jam mulai ')).toBe(true);
    expect(message.endsWith(` via @FluxioWallet_bot ke 5 subscriber?`)).toBe(true);
  });

  it('defaults recurringIntervalHours to 1 when omitted', () => {
    const message = buildSendGuardMessage({
      botUsername: 'FluxioWallet_bot',
      targetType: 'subscribers',
      targetChannelId: '',
      activeSubscriberCount: 5,
      isRecurring: true
    });
    expect(message).toBe('Aktifkan pengiriman setiap 1 jam mulai sekarang via @FluxioWallet_bot ke 5 subscriber?');
  });

  it('treats a missing/undefined subscriber count as zero rather than printing "undefined"', () => {
    const message = buildSendGuardMessage({
      botUsername: 'FluxioWallet_bot',
      targetType: 'subscribers',
      targetChannelId: '',
      activeSubscriberCount: undefined,
      isRecurring: false
    });
    expect(message).toBe('Kirim via @FluxioWallet_bot ke 0 subscriber?');
  });
});
