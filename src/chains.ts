/**
 * Chain IDs and configuration for Kovanica networks.
 * Verified against crates/kovanica-params/src/lib.rs, crates/kovanica-types/src/signing.rs,
 * and mainnet/genesis.json at commit 9a3813cd3f61c8a99d33457eb4eb0dbeef6826d1.
 */

export const CHAIN_IDS = {
  MAINNET: 1,
  TESTNET: 2,
  HYBRID_TESTNET: 2,
  DEVNET: 3,
} as const;

export const NETWORK_TAGS = {
  MAINNET: "1-f35df34c92001436",
  TESTNET: "2-24cdb5fadd98b207",
} as const;

export type ChainId = (typeof CHAIN_IDS)[keyof typeof CHAIN_IDS] | number;

export interface ChainConfig {
  chainId: number;
  name: string;
  ticker: string;
  decimals: number;
  consensus: "Mysticeti" | "Hybrid PoW + GHOSTDAG";
  targetBlockTimeMs: number;
  ghostdagK?: number;
  /** Official `<chain_id>-<16 hex genesis digest>` wire network tag when frozen. */
  networkTag?: string;
  allowsLegacyAddress: boolean;
  /** Suggested local / developer endpoint. */
  defaultRpcUrl?: string;
  description: string;
}

export const KNOWN_CHAINS: Record<number, ChainConfig> = {
  [CHAIN_IDS.MAINNET]: {
    chainId: CHAIN_IDS.MAINNET,
    name: "Mainnet",
    ticker: "KVNC",
    decimals: 9,
    consensus: "Hybrid PoW + GHOSTDAG",
    targetBlockTimeMs: 4000,
    ghostdagK: 5,
    networkTag: NETWORK_TAGS.MAINNET,
    allowsLegacyAddress: false,
    description:
      "Kovanica Mainnet (Hybrid PoW + GHOSTDAG, KovanicaHash, target 4s, K=5, network tag 1-f35df34c92001436). Strict PRO-21 base32 addresses only.",
  },
  [CHAIN_IDS.TESTNET]: {
    chainId: CHAIN_IDS.TESTNET,
    name: "Testnet",
    ticker: "KVNC",
    decimals: 9,
    consensus: "Hybrid PoW + GHOSTDAG",
    targetBlockTimeMs: 4000,
    ghostdagK: 5,
    networkTag: NETWORK_TAGS.TESTNET,
    allowsLegacyAddress: false,
    defaultRpcUrl: "http://127.0.0.1:8545/rpc",
    description:
      "Kovanica Testnet (Hybrid PoW + GHOSTDAG, KovanicaHash, target 4s, K=5, network tag 2-24cdb5fadd98b207). Strict PRO-21 base32 addresses only.",
  },
  [CHAIN_IDS.DEVNET]: {
    chainId: CHAIN_IDS.DEVNET,
    name: "Devnet",
    ticker: "KVNC",
    decimals: 9,
    consensus: "Mysticeti",
    targetBlockTimeMs: 4000,
    allowsLegacyAddress: true,
    defaultRpcUrl: "http://127.0.0.1:8545/rpc",
    description: "Devnet / local cluster testing environment (Mysticeti). Legacy hex addresses allowed.",
  },
};

/**
 * Returns configuration for a known chain ID or undefined if not recognized.
 */
export function getChainConfig(chainId: number): ChainConfig | undefined {
  return KNOWN_CHAINS[chainId];
}

/**
 * Check whether legacy hex addresses are accepted on the given chain ID.
 * Based on `legacy_address_allowed(chain_id)` in `kovanica-types/src/address.rs`.
 */
export function isLegacyAddressAllowed(chainId: number): boolean {
  return chainId === CHAIN_IDS.DEVNET;
}
