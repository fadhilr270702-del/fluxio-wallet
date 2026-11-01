/**
 * Thin accessor over the centralized network configuration
 * (@fluxio/constants/networks). Kept as its own service module so
 * callers don't need to know whether network config comes from constants,
 * remote config, or user overrides in a later phase.
 */
import { NETWORKS, NETWORK_KEYS, getNetwork as getNetworkConfig, listNetworks } from '@fluxio/constants/networks';

export const networks = NETWORKS;

export function getNetwork(key = NETWORK_KEYS.SOLANA) {
  return getNetworkConfig(key);
}

export { listNetworks };
