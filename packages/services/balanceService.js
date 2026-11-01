/**
 * Native-coin balance lookups over public JSON-RPC. Read-only — never
 * touches key material, never signs anything. Built on top of
 * @fluxio/crypto/rpc's fetchRpcWithFallback() (the shared RPC-with-fallback
 * helper, also used by transactionService) rather than duplicating
 * request/response/fallback handling here.
 */
import { fetchRpcWithFallback } from '@fluxio/crypto/rpc';
import { getAccountForNetwork } from '@fluxio/crypto/wallet';
import { NETWORKS, ACCOUNT_TYPES } from '@fluxio/constants';
import { formatUnits } from '@fluxio/utils/formatUnits';

/**
 * Fetches the native-coin balance for one network, given the current
 * public wallet model (as returned by walletService.getPublicWallet()).
 * @param {string} networkKey - a @fluxio/constants network key.
 * @param {object} wallet - the public wallet model (never contains secrets).
 * @returns {Promise<{ formatted: string, symbol: string }>}
 */
export async function getNativeBalance(networkKey, wallet) {
  const network = NETWORKS[networkKey];
  if (!network) {
    throw new Error(`Unknown network: ${networkKey}`);
  }
  // Ethereum/BNB/Base all resolve to the one shared EVM account — reusing
  // the same resolution walletService/background.js already rely on
  // elsewhere, not re-deriving the solana-vs-evm mapping here.
  const { address } = getAccountForNetwork(wallet, networkKey);

  const raw =
    network.accountType === ACCOUNT_TYPES.SOLANA
      ? await fetchSolanaLamports(network, address)
      : await fetchEvmWei(network, address);

  return {
    formatted: formatUnits(raw, network.nativeCurrency.decimals),
    symbol: network.nativeCurrency.symbol
  };
}

async function fetchSolanaLamports(network, address) {
  const data = await fetchRpcWithFallback(network, { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] });
  // Solana's RPC returns lamports as a plain JSON number, not a hex string
  // (unlike EVM) — precision is already bounded by that choice on the
  // RPC's own side, nothing lost by wrapping it in BigInt here.
  return BigInt(data.result.value);
}

async function fetchEvmWei(network, address) {
  const data = await fetchRpcWithFallback(network, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getBalance',
    params: [address, 'latest']
  });
  // eth_getBalance returns wei as a "0x..." hex string precisely so large
  // balances don't get mangled by JSON-number precision — BigInt() parses
  // hex strings natively, no manual parsing needed.
  return BigInt(data.result);
}
