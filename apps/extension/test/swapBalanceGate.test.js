// swapBalanceGate (prompt 0220, owner keputusan 4 / opsi D1) — the
// Review-button balance gate 0219 Revisi 1 proved was missing on BOTH
// chains (the owner's own screen: Review ACTIVE with 0 BNB). One pure
// decision point, locked here for the Solana and EVM cases alike; the
// fee figures below are the exact ones the popup passes (Solana: base
// 5000 + the 150000-lamport priority cap; EVM: the 4e13 wei static
// reserve).
import { describe, it, expect } from 'vitest';
import { decimalToRaw, rawToDecimal, hasSufficientPayBalance } from '../shared/swapBalanceGate.js';

const SOL_FEE_MAX = 155000n; // 5000 + 150000 lamports — the Review row's own static ceiling
const EVM_FEE_RESERVE = 40000000000000n; // popup.js SWAP_EVM_NATIVE_FEE_RESERVE_WEI

describe('decimalToRaw / rawToDecimal', () => {
  it('exact round trips at 9 and 18 decimals, no floats', () => {
    expect(decimalToRaw('0.001', 18)).toBe(1000000000000000n);
    expect(decimalToRaw('0.031339036', 9)).toBe(31339036n);
    expect(rawToDecimal(1000000000000000n, 18)).toBe('0.001');
    expect(rawToDecimal(31339036n, 9)).toBe('0.031339036');
    expect(rawToDecimal(0n, 18)).toBe('0');
  });
  it('rejects junk and over-precise input (null, never a guess)', () => {
    expect(decimalToRaw('abc', 18)).toBeNull();
    expect(decimalToRaw('-1', 18)).toBeNull();
    expect(decimalToRaw('', 18)).toBeNull();
    expect(decimalToRaw('0.0000000001', 9)).toBeNull(); // 10 fraction digits at 9 decimals
  });
});

describe('hasSufficientPayBalance — the 0219 finding, closed (Solana)', () => {
  it('native SOL: the owner-screen case — ANY positive amount with 0 balance is insufficient', () => {
    expect(hasSufficientPayBalance({ isNativePay: true, amount: '0.001', balance: '0', decimals: 9, feeMaxRaw: SOL_FEE_MAX })).toBe(false);
  });
  it('native SOL: amount + the displayed max fee must fit — boundary exact to the lamport', () => {
    // balance 0.01 SOL = 10_000_000 lamports; fee max 155_000.
    expect(hasSufficientPayBalance({ isNativePay: true, amount: '0.009845', balance: '0.01', decimals: 9, feeMaxRaw: SOL_FEE_MAX })).toBe(true); // 9_845_000 + 155_000 = 10_000_000 exactly
    expect(hasSufficientPayBalance({ isNativePay: true, amount: '0.009845001', balance: '0.01', decimals: 9, feeMaxRaw: SOL_FEE_MAX })).toBe(false); // one lamport over
  });
  it('token pay (USDC): fee is paid in native, so amount <= balance alone decides', () => {
    expect(hasSufficientPayBalance({ isNativePay: false, amount: '1.409911', balance: '1.409911', decimals: 6, feeMaxRaw: SOL_FEE_MAX })).toBe(true);
    expect(hasSufficientPayBalance({ isNativePay: false, amount: '1.409912', balance: '1.409911', decimals: 6, feeMaxRaw: SOL_FEE_MAX })).toBe(false);
  });
});

describe('hasSufficientPayBalance — EVM (BNB Chain)', () => {
  it('native BNB: the owner-screen case — 0.001 BNB with 0 balance is insufficient (Review must disable)', () => {
    expect(hasSufficientPayBalance({ isNativePay: true, amount: '0.001', balance: '0', decimals: 18, feeMaxRaw: EVM_FEE_RESERVE })).toBe(false);
  });
  it('native BNB: amount + the static reserve must fit, exact to the wei; a MAX fill (balance − reserve) passes exactly', () => {
    const balance = '0.00198555985'; // the real 0213 figure
    const balanceRaw = decimalToRaw(balance, 18);
    const maxFill = rawToDecimal(balanceRaw - EVM_FEE_RESERVE, 18);
    expect(hasSufficientPayBalance({ isNativePay: true, amount: maxFill, balance, decimals: 18, feeMaxRaw: EVM_FEE_RESERVE })).toBe(true);
    expect(hasSufficientPayBalance({ isNativePay: true, amount: balance, balance, decimals: 18, feeMaxRaw: EVM_FEE_RESERVE })).toBe(false); // full balance leaves nothing for gas
  });
  it('token pay (USDT BEP20): amount <= balance alone', () => {
    expect(hasSufficientPayBalance({ isNativePay: false, amount: '2.99', balance: '2.990000000000000000', decimals: 18, feeMaxRaw: EVM_FEE_RESERVE })).toBe(true);
    expect(hasSufficientPayBalance({ isNativePay: false, amount: '2.990000000000000001', balance: '2.99', decimals: 18, feeMaxRaw: EVM_FEE_RESERVE })).toBe(false);
  });
});

// ---- Tahap C (prompt 0223, owner K3): token pay must ALSO hold native gas ----

const TOKEN_IN_RESERVE = 80000000000000n; // popup.js SWAP_EVM_TOKEN_IN_FEE_RESERVE_WEI (approve + swap)

describe('hasSufficientPayBalance — token-in native gas gate (tahap C, K3)', () => {
  it('USDT enough but BNB short of the two-leg reserve: the gate CLOSES', () => {
    expect(hasSufficientPayBalance({
      isNativePay: false, amount: '0.5', balance: '1.318780516355845246', decimals: 18,
      feeMaxRaw: TOKEN_IN_RESERVE, nativeBalance: '0.00007', nativeDecimals: 18, nativeFeeNeededRaw: TOKEN_IN_RESERVE
    })).toBe(false);
    // Unparseable native balance with a required fee fails CLOSED.
    expect(hasSufficientPayBalance({
      isNativePay: false, amount: '0.5', balance: '1.0', decimals: 18,
      nativeBalance: 'abc', nativeDecimals: 18, nativeFeeNeededRaw: TOKEN_IN_RESERVE
    })).toBe(false);
  });
  it('USDT itself short: closes regardless of the native side', () => {
    expect(hasSufficientPayBalance({
      isNativePay: false, amount: '2.0', balance: '1.318780516355845246', decimals: 18,
      nativeBalance: '0.01', nativeDecimals: 18, nativeFeeNeededRaw: TOKEN_IN_RESERVE
    })).toBe(false);
  });
  it('both sides enough: opens — and callers passing NO native params keep the pre-0223 behavior', () => {
    expect(hasSufficientPayBalance({
      isNativePay: false, amount: '0.5', balance: '1.318780516355845246', decimals: 18,
      nativeBalance: '0.001139113250000000', nativeDecimals: 18, nativeFeeNeededRaw: TOKEN_IN_RESERVE
    })).toBe(true);
    expect(hasSufficientPayBalance({ isNativePay: false, amount: '0.5', balance: '0.6', decimals: 18 })).toBe(true);
  });
});

// 0227 (0225 K3): the gate with ETHEREUM reserve figures — the 0225 spike
// measured an Ethereum swap fee ceiling of 8,25e13 wei, above the old 4e13
// bnb reserve; these cases pin the per-network reserves actually working
// through the SAME pure function (values from shared/swapNetworks.js).
describe('per-network reserves (0227): ethereum figures through the same gate', () => {
  const ETH_NATIVE_RESERVE = 400000000000000n; // 4e14 wei (0225 K3)
  const ETH_TOKEN_IN_RESERVE = 600000000000000n; // 6e14 wei
  it('native pay on ethereum: the 0226 real balance 0.008845262366463 ETH opens for 0.008 but closes for MAX-without-reserve', () => {
    expect(hasSufficientPayBalance({ isNativePay: true, amount: '0.008', balance: '0.008845262366463', decimals: 18, feeMaxRaw: ETH_NATIVE_RESERVE })).toBe(true);
    // 0.0088 + 0.0004 reserve > balance: the reserve closes it.
    expect(hasSufficientPayBalance({ isNativePay: true, amount: '0.0088', balance: '0.008845262366463', decimals: 18, feeMaxRaw: ETH_NATIVE_RESERVE })).toBe(false);
  });
  it('token pay on ethereum: needs the native side to hold the 6e14 wei tokenIn reserve', () => {
    const base = { isNativePay: false, amount: '0.5', balance: '1.0', decimals: 6, nativeDecimals: 18, nativeFeeNeededRaw: ETH_TOKEN_IN_RESERVE };
    expect(hasSufficientPayBalance({ ...base, nativeBalance: '0.0007' })).toBe(true);
    expect(hasSufficientPayBalance({ ...base, nativeBalance: '0.0005' })).toBe(false);
  });
});
