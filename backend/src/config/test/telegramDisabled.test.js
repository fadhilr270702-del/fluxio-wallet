/**
 * Prompt 0191 — unit tests for the TELEGRAM_DISABLED kill switch at the
 * config layer (see env.js's own comment for the 0181/0188 incidents it
 * exists because of). env.js resolves once at import and freezes, so each
 * case sets process.env explicitly (explicit values win over dotenv's
 * backend/.env load — dotenv never overrides an already-set var) and
 * re-imports a fresh module via vi.resetModules().
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const ENV_KEYS = ['TELEGRAM_DISABLED', 'TELEGRAM_BOT_TOKEN_TEST', 'TELEGRAM_BOT_TOKEN_OFFICIAL', 'TELEGRAM_BOT_TOKEN'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

async function freshConfig(env) {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  const { config } = await import('../env.js');
  return config;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('TELEGRAM_DISABLED (prompt 0191)', () => {
  it('=1 with BOTH tokens set: every botToken is null and disabled is true', async () => {
    const config = await freshConfig({
      TELEGRAM_DISABLED: '1',
      TELEGRAM_BOT_TOKEN_TEST: 'real-looking-test-token',
      TELEGRAM_BOT_TOKEN_OFFICIAL: 'real-looking-official-token'
    });
    expect(config.telegram.disabled).toBe(true);
    expect(config.telegram.bots.test.botToken).toBeNull();
    expect(config.telegram.bots.official.botToken).toBeNull();
  });

  it('accepts "true" and "TRUE" (case-insensitive), same result', async () => {
    for (const value of ['true', 'TRUE']) {
      const config = await freshConfig({
        TELEGRAM_DISABLED: value,
        TELEGRAM_BOT_TOKEN_TEST: 'tok-a',
        TELEGRAM_BOT_TOKEN_OFFICIAL: 'tok-b'
      });
      expect(config.telegram.disabled).toBe(true);
      expect(config.telegram.bots.test.botToken).toBeNull();
      expect(config.telegram.bots.official.botToken).toBeNull();
    }
  });

  it('unset or "0": tokens read normally and disabled is false', async () => {
    for (const env of [
      { TELEGRAM_BOT_TOKEN_TEST: 'tok-a', TELEGRAM_BOT_TOKEN_OFFICIAL: 'tok-b' },
      { TELEGRAM_DISABLED: '0', TELEGRAM_BOT_TOKEN_TEST: 'tok-a', TELEGRAM_BOT_TOKEN_OFFICIAL: 'tok-b' }
    ]) {
      const config = await freshConfig(env);
      expect(config.telegram.disabled).toBe(false);
      expect(config.telegram.bots.test.botToken).toBe('tok-a');
      expect(config.telegram.bots.official.botToken).toBe('tok-b');
    }
  });

  it('legacy TELEGRAM_BOT_TOKEN + disabled: null token AND no deprecation warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = await freshConfig({
      TELEGRAM_DISABLED: '1',
      TELEGRAM_BOT_TOKEN: 'legacy-token'
    });
    expect(config.telegram.disabled).toBe(true);
    expect(config.telegram.bots.test.botToken).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
