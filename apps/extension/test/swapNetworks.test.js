// 0227 (owner keputusan 0225 K1/K3) — shared/swapNetworks.js: the popup's
// copy of the EVM swap network list is locked EQUAL to the authoritative
// list in @fluxio/services/evmSwapService.js (the popup cannot import
// @fluxio/* itself — this test is what makes the duplicate safe), and the
// per-network reserves pin the owner's K3 figures.
import { describe, it, expect } from 'vitest';
import { EVM_SWAP_NETWORK_KEYS, SWAP_EVM_FEE_RESERVES_WEI, isEvmSwapNetworkKey, normalizeSwapNetworkKey } from '../shared/swapNetworks.js';
import { EVM_SWAP_NETWORK_KEYS as SERVICE_KEYS } from '@fluxio/services/evmSwapService';

describe('shared/swapNetworks.js — 0225 K1/K3', () => {
  it('the shared list is EXACTLY evmSwapService.EVM_SWAP_NETWORK_KEYS (drift lock)', () => {
    expect([...EVM_SWAP_NETWORK_KEYS]).toEqual([...SERVICE_KEYS]);
  });
  it('reserves pin the owner K3 figures per network, one {native, tokenIn} row per listed network', () => {
    expect(Object.keys(SWAP_EVM_FEE_RESERVES_WEI).sort()).toEqual([...EVM_SWAP_NETWORK_KEYS].sort());
    expect(SWAP_EVM_FEE_RESERVES_WEI.bnb).toEqual({ native: 40000000000000n, tokenIn: 80000000000000n });
    expect(SWAP_EVM_FEE_RESERVES_WEI.ethereum).toEqual({ native: 400000000000000n, tokenIn: 600000000000000n });
    expect(SWAP_EVM_FEE_RESERVES_WEI.base).toEqual({ native: 20000000000000n, tokenIn: 40000000000000n });
  });
  it('normalizeSwapNetworkKey: EVM members keep their key, everything else is the Solana screen', () => {
    expect(normalizeSwapNetworkKey('bnb')).toBe('bnb');
    expect(normalizeSwapNetworkKey('ethereum')).toBe('ethereum');
    expect(normalizeSwapNetworkKey('base')).toBe('base');
    expect(normalizeSwapNetworkKey('solana')).toBe('solana');
    expect(normalizeSwapNetworkKey(undefined)).toBe('solana');
    expect(normalizeSwapNetworkKey('ethereum-sepolia')).toBe('solana');
    expect(isEvmSwapNetworkKey('ethereum')).toBe(true);
    expect(isEvmSwapNetworkKey('solana')).toBe(false);
  });
});
