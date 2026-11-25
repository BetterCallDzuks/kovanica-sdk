/**
 * Waves B, C, and D SDK Support:
 * - Wave B (#4, #5, #6): EIP-1559 dynamic base fee, storage deposit delta, gas-priced fee floor
 * - Wave C (#7, #8, #9): Passkey/WebAuthn typed address derivation, SessionKeyPolicy validation, Scheduler call builders
 * - Wave D (#10, #11): Canonical Bridge call builders, ML-DSA-65 Hybrid PQ address/digest helpers
 */

import { blake3 } from "@noble/hashes/blake3.js";
import {
  concatBytes,
  encodeBincodeBytes32Vec,
  encodeBincodeString,
  u32le,
  u64le,
  u128le,
} from "./contracts";

// --- Wave B: Economics & Scale ---

export const TARGET_BLOCK_BYTES = 480 * 1024;
export const BASE_FEE_MAX_CHANGE_DENOMINATOR = 8n;
export const MIN_BASE_FEE_PER_BYTE = 1n;
export const STORAGE_DEPOSIT_PER_BYTE = 100_000n;

/** EIP-1559 next round base fee per byte (mirrors `kovanica_fee::next_base_fee_per_byte`). */
export function nextBaseFeePerByte(parentBaseFee: bigint, parentBlockBytes: number): bigint {
  const base = parentBaseFee > MIN_BASE_FEE_PER_BYTE ? parentBaseFee : MIN_BASE_FEE_PER_BYTE;
  const target = BigInt(TARGET_BLOCK_BYTES);
  const used = BigInt(parentBlockBytes);
  if (used === target) return base;
  if (used > target) {
    const delta = used - target;
    const inc = (base * delta) / target / BASE_FEE_MAX_CHANGE_DENOMINATOR;
    return base + (inc > 1n ? inc : 1n);
  }
  const delta = target - used;
  const dec = (base * delta) / target / BASE_FEE_MAX_CHANGE_DENOMINATOR;
  const next = base > dec ? base - dec : MIN_BASE_FEE_PER_BYTE;
  return next > MIN_BASE_FEE_PER_BYTE ? next : MIN_BASE_FEE_PER_BYTE;
}

/** Refundable KVNC storage deposit delta (`> 0n` = charge, `< 0n` = refund, `0n` = unchanged). */
export function computeStorageDepositDelta(prevBytes: number, newBytes: number): bigint {
  return BigInt(newBytes - prevBytes) * STORAGE_DEPOSIT_PER_BYTE;
}

/** Combined fee floor: `max(fixedMinFee, txBytes * baseFeePerByte + gasUsed * gasPrice)`. */
export function computeTotalRequiredFee(params: {
  fixedMinFee: bigint;
  txBytes: number;
  baseFeePerByte: bigint;
  gasUsed: bigint;
  gasPrice: bigint;
}): bigint {
  const dynamicFee = BigInt(params.txBytes) * params.baseFeePerByte + params.gasUsed * params.gasPrice;
  return params.fixedMinFee > dynamicFee ? params.fixedMinFee : dynamicFee;
}

// --- Wave C & D: Passkey (WebAuthn), Session Keys, Post-Quantum ---

export enum SignatureScheme {
  Ed25519 = 0,
  Secp256r1WebAuthn = 1,
  MlDsa65Hybrid = 2,
}

export const ML_DSA_65_PUBKEY_BYTES = 1_952;
export const ML_DSA_65_SIG_BYTES = 3_309;

/** Derives a 32-byte typed Kovanica address (`KVNC/addr/v2 || scheme || pubkey`). */
export function deriveTypedAddress(scheme: SignatureScheme, pubkeyBytes: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode("KVNC/addr/v2");
  return blake3(concatBytes([prefix, Uint8Array.of(scheme), pubkeyBytes]));
}

/** Computes the domain-separated hybrid PQ digest for Ed25519 + ML-DSA-65. */
export function computePqHybridDigest(
  ed25519Pubkey: Uint8Array,
  pqPubkeyHash: Uint8Array,
  txHash: Uint8Array,
): Uint8Array {
  const prefix = new TextEncoder().encode("KVNC/pq-mldsa65-hybrid/v1");
  return blake3(concatBytes([prefix, ed25519Pubkey, pqPubkeyHash, txHash]));
}

export interface SessionKeyPolicy {
  owner: string;
  sessionPubkey: string;
  allowedContracts: string[];
  allowedMethods: string[];
  maxSpendAtoms: bigint;
  spentAtoms: bigint;
  expiresRound: bigint;
  revoked: boolean;
}

/** Client-side preflight check matching `kovanica_types::SessionKeyPolicy::authorize_call`. */
export function checkSessionPolicy(
  policy: SessionKeyPolicy,
  contract: string,
  method: string,
  spendAtoms: bigint,
  currentRound: bigint,
): { allowed: true } | { allowed: false; reason: string } {
  if (policy.revoked) return { allowed: false, reason: "session key revoked" };
  if (currentRound >= policy.expiresRound) return { allowed: false, reason: "session key expired" };
  if (policy.allowedContracts.length > 0 && !policy.allowedContracts.includes(contract)) {
    return { allowed: false, reason: "target contract not allowed" };
  }
  if (policy.allowedMethods.length > 0 && !policy.allowedMethods.includes(method)) {
    return { allowed: false, reason: "method not allowed" };
  }
  if (policy.spentAtoms + spendAtoms > policy.maxSpendAtoms) {
    return { allowed: false, reason: "spending limit exceeded" };
  }
  return { allowed: true };
}

// --- Wave C #9: Scheduler Call Builders ---

export function buildSchedulerCreateJobCall(params: {
  targetContract: Uint8Array;
  method: string;
  args: Uint8Array;
  executeAfterHeight: bigint | number;
  intervalHeights: bigint | number;
  maxRuns: number;
  bountyPerRun: bigint | number;
}): Uint8Array {
  if (params.targetContract.length !== 32) {
    throw new Error(`Expected 32-byte targetContract, got ${params.targetContract.length}`);
  }
  return concatBytes([
    params.targetContract,
    encodeBincodeString(params.method),
    u64le(params.args.length),
    params.args,
    u64le(params.executeAfterHeight),
    u64le(params.intervalHeights),
    u32le(params.maxRuns),
    u128le(params.bountyPerRun),
  ]);
}

export function buildSchedulerJobIdCall(jobId: bigint | number): Uint8Array {
  return u64le(jobId);
}

// --- Wave D #10: Bridge Call Builders ---

export function buildBridgeInitCall(params: {
  wrappedToken: Uint8Array;
  assetSymbol: string;
  relayers: Uint8Array[];
  threshold: number;
}): Uint8Array {
  if (params.wrappedToken.length !== 32) {
    throw new Error(`Expected 32-byte wrappedToken, got ${params.wrappedToken.length}`);
  }
  return concatBytes([
    params.wrappedToken,
    encodeBincodeString(params.assetSymbol),
    encodeBincodeBytes32Vec(params.relayers),
    Uint8Array.of(params.threshold),
  ]);
}

export function buildBridgeAttestMintCall(params: {
  sourceChainId: bigint | number;
  sourceTxHash: Uint8Array;
  recipient: Uint8Array;
  amount: bigint | number;
}): Uint8Array {
  if (params.sourceTxHash.length !== 32 || params.recipient.length !== 32) {
    throw new Error("Expected 32-byte sourceTxHash and recipient");
  }
  return concatBytes([
    u64le(params.sourceChainId),
    params.sourceTxHash,
    params.recipient,
    u128le(params.amount),
  ]);
}

export function buildBridgeWithdrawCall(params: {
  destChainId: bigint | number;
  destAddress: Uint8Array;
  amount: bigint | number;
}): Uint8Array {
  return concatBytes([
    u64le(params.destChainId),
    u64le(params.destAddress.length),
    params.destAddress,
    u128le(params.amount),
  ]);
}

// ============================================================================
// Multi-Chain Bridge Registry (Bitcoin, Solana, and All EVM Chains)
// ============================================================================

export type BridgeChainFamily = "bitcoin" | "evm" | "solana";

export interface BridgeChainInfo {
  chainId: number;
  family: BridgeChainFamily;
  name: string;
  nativeWrappedSymbol: string;
  supportedAssets: readonly string[];
  minConfirmations: number;
}

export const BRIDGE_CHAINS: ReadonlyArray<BridgeChainInfo> = Object.freeze([
  { chainId: 0, family: "bitcoin", name: "Bitcoin", nativeWrappedSymbol: "wBTC", supportedAssets: ["wBTC"], minConfirmations: 6 },
  { chainId: 1, family: "evm", name: "Ethereum", nativeWrappedSymbol: "wETH", supportedAssets: ["wETH", "wUSDC", "wUSDT", "wEURC"], minConfirmations: 12 },
  { chainId: 10, family: "evm", name: "Optimism", nativeWrappedSymbol: "wETH", supportedAssets: ["wETH", "wUSDC", "wUSDT"], minConfirmations: 20 },
  { chainId: 56, family: "evm", name: "BNB Smart Chain", nativeWrappedSymbol: "wBNB", supportedAssets: ["wBNB", "wUSDT", "wUSDC"], minConfirmations: 15 },
  { chainId: 137, family: "evm", name: "Polygon PoS", nativeWrappedSymbol: "wPOL", supportedAssets: ["wPOL", "wUSDC", "wUSDT"], minConfirmations: 64 },
  { chainId: 501, family: "solana", name: "Solana", nativeWrappedSymbol: "wSOL", supportedAssets: ["wSOL", "wUSDC", "wUSDT"], minConfirmations: 32 },
  { chainId: 8453, family: "evm", name: "Base", nativeWrappedSymbol: "wETH", supportedAssets: ["wETH", "wUSDC", "wEURC"], minConfirmations: 20 },
  { chainId: 42161, family: "evm", name: "Arbitrum One", nativeWrappedSymbol: "wETH", supportedAssets: ["wETH", "wUSDC", "wUSDT"], minConfirmations: 20 },
  { chainId: 43114, family: "evm", name: "Avalanche C-Chain", nativeWrappedSymbol: "wAVAX", supportedAssets: ["wAVAX", "wUSDC", "wUSDT"], minConfirmations: 12 },
  { chainId: 59144, family: "evm", name: "Linea", nativeWrappedSymbol: "wETH", supportedAssets: ["wETH", "wUSDC"], minConfirmations: 20 },
  { chainId: 81457, family: "evm", name: "Blast", nativeWrappedSymbol: "wETH", supportedAssets: ["wETH", "wUSDB"], minConfirmations: 20 },
  { chainId: 534352, family: "evm", name: "Scroll", nativeWrappedSymbol: "wETH", supportedAssets: ["wETH", "wUSDC"], minConfirmations: 20 },
]);

export function getBridgeChainFamily(chainId: number): BridgeChainFamily {
  if (chainId === 0) return "bitcoin";
  if (chainId === 501) return "solana";
  return "evm";
}

export function getBridgeChainById(chainId: number): BridgeChainInfo {
  const known = BRIDGE_CHAINS.find((c) => c.chainId === chainId);
  if (known) return known;
  return {
    chainId,
    family: getBridgeChainFamily(chainId),
    name: `EVM Chain #${chainId}`,
    nativeWrappedSymbol: "wETH",
    supportedAssets: ["wETH", "wUSDC", "wUSDT"],
    minConfirmations: 20,
  };
}

export function validateExternalBridgeAddress(chainId: number, address: string): boolean {
  const trimmed = address.trim();
  const family = getBridgeChainFamily(chainId);
  if (family === "bitcoin") {
    return /^(bc1[a-z0-9]{25,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(trimmed);
  }
  if (family === "solana") {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);
  }
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed);
}
