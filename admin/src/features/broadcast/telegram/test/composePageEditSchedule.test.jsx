// @vitest-environment jsdom
/**
 * Prompt 0246 — the REAL ComposePage in edit mode for an active recurring
 * broadcast: load, schedule section, and the Save CLICK PATH down to the
 * exact arguments of the API call. Born from this project's own lesson
 * that a text or helper test does not prove a button works: the page's
 * own wiring (state, buildEditPayload, performSubmit, navigate) is what
 * runs here.
 *
 * Mocked, and why: the API module (no backend in a unit test), the bot
 * context hooks (their provider lives in the app shell), and the two
 * heavy editor leaves — RichTextEditor (TipTap) is replaced by a stub that
 * reports a real TipTap JSON doc through the same onChange the page
 * already listens on, so title/body still go through the page's real
 * validation and Telegram-HTML conversion. Nothing about the schedule
 * section is mocked.
 */
import React, { useEffect } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { toDatetimeLocalValue, fromDatetimeLocalValue } from '../../../../utils/formatDate.js';

const api = vi.hoisted(() => ({
  getTelegramStatus: vi.fn(),
  createTelegramBroadcast: vi.fn(),
  getTelegramBroadcast: vi.fn(),
  listTelegramBroadcasts: vi.fn(),
  updateTelegramBroadcastContent: vi.fn(),
  uploadTelegramBroadcastImage: vi.fn(),
  uploadTelegramBroadcastVideo: vi.fn()
}));
vi.mock('../../../../services/telegramBroadcastApi.js', () => api);
vi.mock('../../../../hooks/useBotContext.js', () => ({
  default: () => ({ botId: 'test', botMeta: { username: 'FluxioTrial_bot', label: 'Bot Percobaan' } })
}));
vi.mock('../../../../hooks/useBotSwitchGuard.js', () => ({ default: () => {} }));
vi.mock('../EmojiPickerButton.jsx', () => ({ default: () => null }));
vi.mock('../ButtonPremiumIconControl.jsx', () => ({ default: () => null }));
vi.mock('../RichTextEditor.jsx', () => ({
  default: function RichTextEditorStub({ onChange, singleLine }) {
    useEffect(() => {
      onChange({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: singleLine ? 'Who holds your crypto?' : 'Your keys, your crypto.' }] }]
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid={singleLine ? 'title-editor' : 'body-editor'} />;
  }
}));

import ComposePage from '../ComposePage.jsx';

const HOUR = 60 * 60 * 1000;
const NEXT_ROUND_AT = new Date(Math.floor((Date.now() + 26 * HOUR) / 60000) * 60000).toISOString();

/** GET /admin/broadcast/telegram/:id — the real API shape of an active recurring broadcast. */
function recurringBroadcast() {
  return {
    id: 'b-0246',
    bot: 'test',
    title: 'Who holds your crypto?',
    titleFormat: 'html',
    body: 'Your keys, your crypto.',
    bodyFormat: 'html',
    mediaUrl: null,
    mediaFileId: null,
    mediaServerFilename: null,
    mediaType: null,
    targetType: 'subscribers',
    targetChannelId: null,
    status: 'recurring',
    scheduledAt: null,
    totalCount: 0,
    sentCount: 3,
    failedCount: 0,
    buttons: [{ text: 'GET FLUXIO', url: 'https://fluxiowallet.com', iconCustomEmojiId: null }],
    errorMessage: null,
    isRecurring: true,
    recurringLastSentAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    recurringIntervalHours: 24,
    recurringStartsAt: new Date(Date.now() - 70 * HOUR).toISOString(),
    recurringLastRoundSentCount: 3,
    recurringLastRoundFailedCount: 0,
    recurringNextRoundAt: NEXT_ROUND_AT,
    recurringLastRound: null
  };
}

function renderComposePage() {
  return render(
    <MemoryRouter initialEntries={['/broadcast/telegram']}>
      <Routes>
        <Route path="/broadcast/telegram" element={<ComposePage />} />
        <Route path="/broadcast/history" element={<div>History page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function renderEditPage() {
  return render(
    <MemoryRouter initialEntries={['/broadcast/telegram/b-0246/edit']}>
      <Routes>
        <Route path="/broadcast/telegram/:id/edit" element={<ComposePage />} />
        <Route path="/broadcast/history" element={<div>History page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getTelegramStatus.mockResolvedValue({ botConfigured: true, botConnected: true, activeSubscriberCount: 3, activeRecurringBroadcast: null });
  api.listTelegramBroadcasts.mockResolvedValue({ broadcasts: [] });
  api.getTelegramBroadcast.mockResolvedValue({ broadcast: recurringBroadcast() });
  api.updateTelegramBroadcastContent.mockResolvedValue({ broadcast: recurringBroadcast() });
});

afterEach(cleanup);

describe('ComposePage, compose mode, "Repeat every" choices (0246 Revisi 1)', () => {
  it('offers 27 choices in order: 1 to 24 hours with no gaps, then 48, 72, 168, labeled "1 hour" and "N hours"', async () => {
    renderComposePage();
    fireEvent.change(await screen.findByLabelText('When'), { target: { value: 'recurring' } });
    const select = await screen.findByLabelText('Repeat every');
    const options = Array.from(select.querySelectorAll('option'));
    const expectedHours = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 48, 72, 168];
    expect(options).toHaveLength(27);
    expect(options.map((o) => Number(o.value))).toEqual(expectedHours);
    expect(options.map((o) => o.textContent.trim())).toEqual(expectedHours.map((h) => (h === 1 ? '1 hour' : `${h} hours`)));
    expect(select.value).toBe('1');
  });

  it('a choice that did not exist before (17 hours) can be picked and stays selected', async () => {
    renderComposePage();
    fireEvent.change(await screen.findByLabelText('When'), { target: { value: 'recurring' } });
    const select = await screen.findByLabelText('Repeat every');
    fireEvent.change(select, { target: { value: '17' } });
    expect(select.value).toBe('17');
    expect(select.querySelectorAll('option')).toHaveLength(27);
  });
});

describe('ComposePage, edit mode, recurring broadcast (0246)', () => {
  it('shows the schedule section prefilled from the broadcast, with the new hint and without the old "unchanged by this edit" text', async () => {
    renderEditPage();
    const interval = await screen.findByLabelText('Interval (hours)');
    expect(interval.value).toBe('24');
    expect(screen.getByLabelText('Next round').value).toBe(toDatetimeLocalValue(NEXT_ROUND_AT));
    expect(screen.getByText('Schedule changes apply from the next round. The round in progress finishes first.')).toBeTruthy();
    expect(screen.queryByText(/unchanged by this edit/)).toBeNull();
    expect(screen.queryByText(/schedule itself is unaffected/)).toBeNull();
    expect(api.getTelegramBroadcast).toHaveBeenCalledWith('b-0246');
  });

  it('Save changes with the schedule untouched sends the content alone and goes back to History', async () => {
    renderEditPage();
    await screen.findByLabelText('Interval (hours)');
    fireEvent.click(screen.getByText('Save changes'));
    await screen.findByText('History page');
    expect(api.updateTelegramBroadcastContent).toHaveBeenCalledTimes(1);
    const [id, payload] = api.updateTelegramBroadcastContent.mock.calls[0];
    expect(id).toBe('b-0246');
    expect(payload).toEqual({
      title: 'Who holds your crypto?',
      titleFormat: 'html',
      body: 'Your keys, your crypto.',
      bodyFormat: 'html',
      mediaUrl: null,
      mediaFileId: null,
      mediaServerFilename: null,
      mediaType: null,
      buttons: [{ text: 'GET FLUXIO', url: 'https://fluxiowallet.com', iconCustomEmojiId: null }]
    });
  });

  it('Save changes after editing both inputs sends content AND schedule in the one request', async () => {
    renderEditPage();
    const interval = await screen.findByLabelText('Interval (hours)');
    const chosenLocal = toDatetimeLocalValue(new Date(Date.now() + 50 * HOUR).toISOString());
    fireEvent.change(interval, { target: { value: '72' } });
    fireEvent.change(screen.getByLabelText('Next round'), { target: { value: chosenLocal } });
    fireEvent.click(screen.getByText('Save changes'));
    await screen.findByText('History page');
    expect(api.updateTelegramBroadcastContent).toHaveBeenCalledTimes(1);
    const [, payload] = api.updateTelegramBroadcastContent.mock.calls[0];
    expect(payload.intervalHours).toBe(72);
    expect(payload.nextRunAt).toBe(fromDatetimeLocalValue(chosenLocal));
    expect(payload.title).toBe('Who holds your crypto?');
    expect(payload.body).toBe('Your keys, your crypto.');
  });

  it('a next round in the past stops on the page: the message shows, nothing is sent, the page stays', async () => {
    renderEditPage();
    await screen.findByLabelText('Interval (hours)');
    const pastLocal = toDatetimeLocalValue(new Date(Date.now() - 3 * HOUR).toISOString());
    fireEvent.change(screen.getByLabelText('Next round'), { target: { value: pastLocal } });
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(screen.getByText('The next round must be in the future.')).toBeTruthy());
    expect(api.updateTelegramBroadcastContent).not.toHaveBeenCalled();
    expect(screen.queryByText('History page')).toBeNull();
  });
});
