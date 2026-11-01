/**
 * Prompt 0191 — start-gating tests for the TELEGRAM_DISABLED kill switch:
 * with the switch on and REAL-LOOKING tokens present, the poller must not
 * start (and never call getUpdates — asserted by stubbing global fetch)
 * and the worker must not start either. Fresh module graph per the same
 * vi.resetModules() + explicit-process.env pattern as
 * config/test/telegramDisabled.test.js.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';

const ENV_KEYS = ['TELEGRAM_DISABLED', 'TELEGRAM_BOT_TOKEN_TEST', 'TELEGRAM_BOT_TOKEN_OFFICIAL', 'TELEGRAM_BOT_TOKEN'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
});

describe('TELEGRAM_DISABLED start gating (prompt 0191)', () => {
  it('poller and worker both refuse to start despite real-looking tokens, and no Telegram API call is ever made', async () => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.TELEGRAM_DISABLED = '1';
    process.env.TELEGRAM_BOT_TOKEN_TEST = 'real-looking-test-token';
    process.env.TELEGRAM_BOT_TOKEN_OFFICIAL = 'real-looking-official-token';

    const fetchSpy = vi.fn(() => Promise.reject(new Error('network must never be touched')));
    vi.stubGlobal('fetch', fetchSpy);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { getTelegramClient } = await import('../client.js');
    const { startTelegramPoller } = await import('../poller.js');
    const { startBroadcastWorker } = await import('../worker.js');

    expect(getTelegramClient('test')).toBeNull();
    expect(getTelegramClient('official')).toBeNull();

    startTelegramPoller('test');
    startTelegramPoller('official');
    startBroadcastWorker();

    const logged = log.mock.calls.map((c) => c.join(' '));
    expect(logged).toContain("[telegram] bot 'test' has no token configured — subscriber poller not started.");
    expect(logged).toContain("[telegram] bot 'official' has no token configured — subscriber poller not started.");
    expect(logged).toContain('[telegram] no bot has a token configured — broadcast worker not started.');

    // Give any wrongly-started loop a beat to fire — nothing may touch the network.
    await new Promise((r) => setTimeout(r, 150));
    expect(fetchSpy).not.toHaveBeenCalled();

    log.mockRestore();
  });
});
