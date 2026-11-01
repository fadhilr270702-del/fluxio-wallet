/**
 * verifyTokenAccount (prompt 0209) — the swap fee-account guard's
 * on-chain validity check, born from the 0208 incident (swap lesson #8:
 * the embedded treasury USDC ATA was closed while a build carrying its
 * address sat in CWS review). VALID means all four of: the account
 * exists, its owner program is the SPL Token Program, its parsed mint
 * matches, and its parsed owner matches — existence alone deliberately
 * does NOT pass (a plain lamport transfer to a closed ATA's address
 * leaves a System-owned account there). Endpoint handling follows
 * getTrustedBlockHeight's per-endpoint trust pattern: an answer whose
 * SHAPE can't be trusted moves to the next endpoint instead of being
 * read as "account missing" (swap lesson 5 — a live RPC with the wrong
 * semantics is more dangerous than a dead one), and exhausting every
 * endpoint yields 'unverified', never a guessed 'invalid'. The response
 * fixtures mirror the fase-1 read-only proof against the real chain
 * (28 Sep 2026, api.mainnet-beta + publicnode, identical shapes).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { verifyTokenAccount } from '../transactionService.js';

const FIRST = 'https://first-rpc.example.test';
const SECOND = 'https://second-rpc.example.test';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const TREASURY = 'FnjdJcYsQShxUTPJjgVnjjvw5kKsVwfxtFCWBJMjPiwQ';
const OTHER_WALLET = 'HM2tV6hdcRFvPkcspwWvs9KU7rwKTyEa6UXGPc6v6TFy';
const ATA = '6tyoAgzhyGgGNrxyyR68DHvfUySo4kdh1RukgU78Ep2j';

/** The real treasury ATA's live jsonParsed `value` shape (fase-1 proof). */
function tokenAccountValue({ mint = USDC_MINT, owner = TREASURY } = {}) {
  return {
    data: {
      parsed: {
        info: { isNative: false, mint, owner, state: 'initialized', tokenAmount: { amount: '480925', decimals: 6, uiAmount: 0.480925, uiAmountString: '0.480925' } },
        type: 'account'
      },
      program: 'spl-token',
      space: 165
    },
    executable: false,
    lamports: 1488440,
    owner: TOKEN_PROGRAM,
    rentEpoch: 0,
    space: 165
  };
}

/** A System-owned account at the same address — what a plain lamport transfer to a closed ATA's address leaves behind. */
function systemAccountValue() {
  return { data: ['', 'base64'], executable: false, lamports: 5000, owner: '11111111111111111111111111111111', rentEpoch: 0, space: 0 };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function installAccountInfoFetch(resultByUrl) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const { method, params } = JSON.parse(options.body);
    calls.push({ url: String(url), method, address: params[0], config: params[1] });
    expect(method).toBe('getAccountInfo');
    const result = resultByUrl(String(url));
    if (result instanceof Error) throw result;
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };
  return calls;
}

const EXPECT = { network: 'solana', address: ATA, expectedMint: USDC_MINT, expectedOwner: TREASURY, endpoints: [FIRST, SECOND] };

describe('verifyTokenAccount', () => {
  it('VALID: existing Token-Program account with the exact expected mint and owner — and the request really asked jsonParsed', async () => {
    const calls = installAccountInfoFetch(() => ({ context: { slot: 451343619 }, value: tokenAccountValue() }));
    const verdict = await verifyTokenAccount(EXPECT);
    expect(verdict).toEqual({ status: 'valid', reason: null });
    expect(calls).toHaveLength(1); // first endpoint answered well-formed — no reason to touch the second
    expect(calls[0].address).toBe(ATA);
    expect(calls[0].config.encoding).toBe('jsonParsed');
  });

  it("INVALID 'missing': a well-formed null value is a trusted verdict (the account does not exist)", async () => {
    const calls = installAccountInfoFetch(() => ({ context: { slot: 451343624 }, value: null }));
    const verdict = await verifyTokenAccount(EXPECT);
    expect(verdict).toEqual({ status: 'invalid', reason: 'missing' });
    expect(calls).toHaveLength(1);
  });

  it("INVALID 'wrong_program': a System-owned account at the address (a lamport transfer to a closed ATA) fails — existence alone is never enough", async () => {
    installAccountInfoFetch(() => ({ context: { slot: 1 }, value: systemAccountValue() }));
    const verdict = await verifyTokenAccount(EXPECT);
    expect(verdict).toEqual({ status: 'invalid', reason: 'wrong_program' });
  });

  it("INVALID 'wrong_mint': a real token account holding another mint (fase 1's live case C — the tester's USDT ATA shape)", async () => {
    installAccountInfoFetch(() => ({ context: { slot: 451343630 }, value: tokenAccountValue({ mint: USDT_MINT, owner: OTHER_WALLET }) }));
    const verdict = await verifyTokenAccount(EXPECT);
    expect(verdict).toEqual({ status: 'invalid', reason: 'wrong_mint' });
  });

  it("INVALID 'wrong_owner': right mint, another wallet's account", async () => {
    installAccountInfoFetch(() => ({ context: { slot: 1 }, value: tokenAccountValue({ owner: OTHER_WALLET }) }));
    const verdict = await verifyTokenAccount(EXPECT);
    expect(verdict).toEqual({ status: 'invalid', reason: 'wrong_owner' });
  });

  it("UNVERIFIED: transport failure on EVERY endpoint — never guessed 'invalid'", async () => {
    const calls = installAccountInfoFetch(() => new Error('connection reset'));
    const verdict = await verifyTokenAccount(EXPECT);
    expect(verdict).toEqual({ status: 'unverified', reason: 'no_trusted_answer' });
    expect(calls.map((c) => c.url)).toEqual([FIRST, SECOND]); // both endpoints genuinely tried
  });

  it('a shapeless answer (no `value` key at all) is UNTRUSTED: skipped, and the SECOND endpoint delivers the verdict', async () => {
    const calls = installAccountInfoFetch((url) =>
      url === FIRST ? { something: 'else' } : { context: { slot: 1 }, value: tokenAccountValue() }
    );
    const verdict = await verifyTokenAccount(EXPECT);
    expect(verdict).toEqual({ status: 'valid', reason: null });
    expect(calls.map((c) => c.url)).toEqual([FIRST, SECOND]);
  });

  it('a Token-Program account WITHOUT the jsonParsed structure is UNTRUSTED (the endpoint ignored our encoding): skipped, second endpoint decides', async () => {
    const unparsed = { ...tokenAccountValue(), data: ['AAAA', 'base64'] }; // token-program owner but raw data — wrong semantics for a jsonParsed request
    const calls = installAccountInfoFetch((url) =>
      url === FIRST ? { context: { slot: 1 }, value: unparsed } : { context: { slot: 2 }, value: null }
    );
    const verdict = await verifyTokenAccount(EXPECT);
    expect(verdict).toEqual({ status: 'invalid', reason: 'missing' }); // the SECOND endpoint's trusted answer, not a guess from the first
    expect(calls.map((c) => c.url)).toEqual([FIRST, SECOND]);
  });

  it('rejects missing inputs loudly instead of verifying the wrong thing', async () => {
    installAccountInfoFetch(() => ({ context: { slot: 1 }, value: null }));
    await expect(verifyTokenAccount({ ...EXPECT, address: '' })).rejects.toThrow('token account address');
    await expect(verifyTokenAccount({ ...EXPECT, expectedMint: '' })).rejects.toThrow('expectedMint');
    await expect(verifyTokenAccount({ ...EXPECT, expectedOwner: undefined })).rejects.toThrow('expectedOwner');
  });
});
