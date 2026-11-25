/**
 * Institutional RWA (KVP-106) Compliance, Batch Allowlist & Scheduled Dividend Helpers.
 *
 * Complements `RwaClient` with:
 * - Batch KYC/allowlist Wave A `Batch` builders & signers (strict PRO-21 validation)
 * - Compliance control encoders (`rwa_set_paused`, `rwa_forced_transfer` clawback with reason)
 * - Supply cap preflight enforcement
 * - On-chain `RwaState` Bincode compliance status decoder & storage reader
 * - Automated pro-rata coupon/dividend distribution payloads for `kovanica-scheduler`
 */

import { blake3 } from "@noble/hashes/blake3.js";
import { encodeAddress, isValidAddress } from "./address";
import {
  DEFAULT_CALL_GAS_LIMIT,
  bytesToHex,
  concatBytes,
  encodeBincodeString,
  hexToBytes,
  parseContractAddress,
  u32le,
  u128le,
} from "./contracts";
import type { KovanicaAddress } from "./types";
import {
  type BatchAction,
  MAX_BATCH_ACTIONS,
  signBatchTransaction,
} from "./wave-a";
import { buildSchedulerCreateJobCall } from "./waves-bcd";

export const RWA_STATE_STORAGE_KEY = "kvnc/v1/rwa_state";

export interface RwaAllowlistEntry {
  /** Holder address (`kvnc...dag` PRO-21 string or 32-byte Uint8Array). */
  address: KovanicaAddress | Uint8Array;
  /** `true` to add/verify on allowlist; `false` to revoke. */
  allowed: boolean;
  /** Optional KYC tier (default `1`). */
  kycTier?: number;
}

export interface RwaComplianceStatus {
  assetIdHex: string;
  name: string;
  symbol: string;
  assetClass: string;
  uniqueId: string;
  version: number;
  jurisdiction: string;
  metadataHashHex: string;
  metadataUri: string;
  legalUri: string;
  custodyUri: string;
  issuerAddress: KovanicaAddress;
  decimals: number;
  maxSupply: bigint;
  totalSupply: bigint;
  paused: boolean;
  holderCount: number;
  frozenCount: number;
  balances: Array<{ address: KovanicaAddress; balance: bigint }>;
  frozenAccounts: KovanicaAddress[];
}

export interface RwaDividendHolder {
  address: string;
  balance: bigint;
}

export interface RwaDividendPayoutItem {
  address: string;
  balance: bigint;
  shareBps: number;
  payoutAtoms: bigint;
}

export interface RwaProRataDividendPlan {
  totalPayoutAtoms: bigint;
  distributedAtoms: bigint;
  dustRemainderAtoms: bigint;
  eligibleSupply: bigint;
  payouts: RwaDividendPayoutItem[];
}

/** Validates a holder address (strict PRO-21 `kvnc...dag` when passed as string). */
export function parseStrictRwaHolderAddress(address: string | Uint8Array): Uint8Array {
  if (address instanceof Uint8Array) {
    if (address.length !== 32) {
      throw new Error(`RWA holder address: expected 32 bytes, got ${address.length}`);
    }
    return new Uint8Array(address);
  }
  const trimmed = address.trim();
  if (!isValidAddress(trimmed, 1) && !isValidAddress(trimmed, 2)) {
    throw new Error(
      `RWA holder address "${trimmed}" is not a valid PRO-21 kvnc...dag address`,
    );
  }
  return parseContractAddress(trimmed);
}

/** Encodes `rwa_set_allowlist(account: [u8;32], allowed: bool, kyc_tier: u8)`. */
export function buildRwaAllowlistCall(params: RwaAllowlistEntry): Uint8Array {
  const account = parseStrictRwaHolderAddress(params.address);
  const tier = params.kycTier ?? 1;
  if (!Number.isInteger(tier) || tier < 0 || tier > 255) {
    throw new RangeError(`kycTier must be an integer 0..=255, got ${tier}`);
  }
  return concatBytes([account, Uint8Array.of(params.allowed ? 1 : 0, tier)]);
}

/** Encodes `rwa_set_paused(paused: bool)`. */
export function buildRwaPauseCall(paused: boolean): Uint8Array {
  return Uint8Array.of(paused ? 1 : 0);
}

/**
 * Encodes `rwa_forced_transfer(from: [u8;32], to: [u8;32], amount: u128, reason: String)`
 * for regulated issuer clawback / court-ordered transfer with audit reason metadata.
 */
export function buildRwaForcedTransferCall(params: {
  from: string | Uint8Array;
  to: string | Uint8Array;
  amount: bigint | number;
  reason: string;
}): Uint8Array {
  const reason = params.reason.trim();
  if (reason.length === 0 || reason.length > 256) {
    throw new Error("buildRwaForcedTransferCall: reason must be 1..=256 characters");
  }
  const fromBytes = parseStrictRwaHolderAddress(params.from);
  const toBytes = parseStrictRwaHolderAddress(params.to);
  return concatBytes([
    fromBytes,
    toBytes,
    u128le(params.amount),
    encodeBincodeString(reason),
  ]);
}

/** Preflight supply-cap enforcement check (`maxSupply === 0n` means uncapped). */
export function checkRwaMintCap(params: {
  currentSupply: bigint;
  maxSupply: bigint;
  mintAmount: bigint;
}): { allowed: true; nextSupply: bigint; remainingCap: bigint | null } | { allowed: false; reason: string } {
  if (params.mintAmount <= 0n) {
    return { allowed: false, reason: "mintAmount must be positive" };
  }
  const nextSupply = params.currentSupply + params.mintAmount;
  if (params.maxSupply > 0n && nextSupply > params.maxSupply) {
    return {
      allowed: false,
      reason: `Mint of ${params.mintAmount} exceeds max supply cap (${params.currentSupply}/${params.maxSupply})`,
    };
  }
  return {
    allowed: true,
    nextSupply,
    remainingCap: params.maxSupply > 0n ? params.maxSupply - nextSupply : null,
  };
}

/**
 * Builds Wave A `BatchAction[]` for updating up to 16 KYC/allowlist entries in 1 atomic tx.
 */
export function buildRwaBatchAllowlistActions(params: {
  rwaContract: Uint8Array | string;
  entries: RwaAllowlistEntry[];
  gasLimitPerEntry?: bigint;
}): BatchAction[] {
  if (params.entries.length === 0) {
    throw new Error("buildRwaBatchAllowlistActions: entries must be non-empty");
  }
  if (params.entries.length > MAX_BATCH_ACTIONS) {
    throw new Error(
      `buildRwaBatchAllowlistActions: max ${MAX_BATCH_ACTIONS} entries per Wave A batch, got ${params.entries.length}`,
    );
  }
  const contractBytes = parseContractAddress(params.rwaContract);
  const gasLimit = params.gasLimitPerEntry ?? DEFAULT_CALL_GAS_LIMIT;
  return params.entries.map((entry) => ({
    kind: "call",
    contract: contractBytes,
    value: 0n,
    method: "rwa_set_allowlist",
    args: buildRwaAllowlistCall(entry),
    gasLimit,
  }));
}

/** Splits an arbitrarily large allowlist update into Wave A-compliant batches (<= 16 actions each). */
export function chunkRwaAllowlistBatches(params: {
  rwaContract: Uint8Array | string;
  entries: RwaAllowlistEntry[];
  gasLimitPerEntry?: bigint;
}): BatchAction[][] {
  if (params.entries.length === 0) return [];
  const chunks: BatchAction[][] = [];
  for (let i = 0; i < params.entries.length; i += MAX_BATCH_ACTIONS) {
    chunks.push(
      buildRwaBatchAllowlistActions({
        rwaContract: params.rwaContract,
        entries: params.entries.slice(i, i + MAX_BATCH_ACTIONS),
        gasLimitPerEntry: params.gasLimitPerEntry,
      }),
    );
  }
  return chunks;
}

/** Signs a 1-tx Wave A atomic batch allowlist update. */
export function signRwaBatchAllowlistUpdate(params: {
  chainId: bigint | number;
  senderPrivateKey: Uint8Array;
  senderPublicKey: Uint8Array;
  nonce: bigint | number;
  fee: bigint | number;
  rwaContract: Uint8Array | string;
  entries: RwaAllowlistEntry[];
  gasLimitPerEntry?: bigint;
}) {
  const actions = buildRwaBatchAllowlistActions({
    rwaContract: params.rwaContract,
    entries: params.entries,
    gasLimitPerEntry: params.gasLimitPerEntry,
  });
  return {
    actions,
    signed: signBatchTransaction({
      chainId: params.chainId,
      senderPrivateKey: params.senderPrivateKey,
      senderPublicKey: params.senderPublicKey,
      nonce: params.nonce,
      actions,
      fee: params.fee,
    }),
  };
}

// ============================================================================
// On-Chain RwaState Bincode Decoder & Storage Reader
// ============================================================================

class BincodeCursor {
  offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private ensure(n: number): void {
    if (this.offset + n > this.bytes.length) {
      throw new Error(`BincodeCursor: unexpected EOF at offset ${this.offset} (need ${n} bytes)`);
    }
  }

  readU8(): number {
    this.ensure(1);
    return this.bytes[this.offset++]!;
  }

  readBool(): boolean {
    const v = this.readU8();
    if (v !== 0 && v !== 1) throw new Error(`BincodeCursor: invalid bool byte ${v}`);
    return v === 1;
  }

  readU32(): number {
    this.ensure(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readU64(): bigint {
    this.ensure(8);
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  readU128(): bigint {
    this.ensure(16);
    const lo = this.view.getBigUint64(this.offset, true);
    const hi = this.view.getBigUint64(this.offset + 8, true);
    this.offset += 16;
    return (hi << 64n) | lo;
  }

  readBytes(len: number): Uint8Array {
    this.ensure(len);
    const out = this.bytes.slice(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }

  readString(): string {
    const len = Number(this.readU64());
    const raw = this.readBytes(len);
    return new TextDecoder().decode(raw);
  }
}

/**
 * Decodes Bincode-serialized `kovanica_rwa::RwaState` from storage key `kvnc/v1/rwa_state`.
 */
export function decodeRwaComplianceState(bytes: Uint8Array): RwaComplianceStatus {
  const c = new BincodeCursor(bytes);
  const assetId = c.readBytes(32);
  const name = c.readString();
  const symbol = c.readString();
  const assetClass = c.readString();
  const uniqueId = c.readString();
  const version = c.readU32();
  const jurisdiction = c.readString();
  const metadataHash = c.readBytes(32);
  const metadataUri = c.readString();
  const legalUri = c.readString();
  const custodyUri = c.readString();
  const issuer = c.readBytes(32);
  const decimals = c.readU8();
  const maxSupply = c.readU128();
  const totalSupply = c.readU128();
  const paused = c.readBool();

  const balancesLen = Number(c.readU64());
  const balances: Array<{ address: KovanicaAddress; balance: bigint }> = [];
  for (let i = 0; i < balancesLen; i++) {
    const addr = c.readBytes(32);
    const bal = c.readU128();
    balances.push({ address: encodeAddress(addr), balance: bal });
  }

  const frozenLen = Number(c.readU64());
  const frozenAccounts: KovanicaAddress[] = [];
  for (let i = 0; i < frozenLen; i++) {
    const addr = c.readBytes(32);
    const isFrozen = c.readBool();
    if (isFrozen) {
      frozenAccounts.push(encodeAddress(addr));
    }
  }

  return {
    assetIdHex: bytesToHex(assetId),
    name,
    symbol,
    assetClass,
    uniqueId,
    version,
    jurisdiction,
    metadataHashHex: bytesToHex(metadataHash),
    metadataUri,
    legalUri,
    custodyUri,
    issuerAddress: encodeAddress(issuer),
    decimals,
    maxSupply,
    totalSupply,
    paused,
    holderCount: balances.length,
    frozenCount: frozenAccounts.length,
    balances,
    frozenAccounts,
  };
}

/**
 * Reads and decodes live KVP-106 `RwaState` from contract storage slot `blake3("kvnc/v1/rwa_state")`.
 */
export async function readRwaComplianceStatus(
  client: { getStorageAt: (contract: string, key: string) => Promise<string | null> },
  rwaContract: Uint8Array | string,
): Promise<RwaComplianceStatus | null> {
  const contractBytes = parseContractAddress(rwaContract);
  const slotKey = bytesToHex(blake3(new TextEncoder().encode(RWA_STATE_STORAGE_KEY)));
  const rawHex = await client.getStorageAt(bytesToHex(contractBytes), slotKey);
  if (!rawHex || rawHex === "0x" || rawHex === "") return null;
  const clean = rawHex.startsWith("0x") ? rawHex.slice(2) : rawHex;
  if (clean.length === 0) return null;
  return decodeRwaComplianceState(hexToBytes(clean));
}

// ============================================================================
// Automated Coupon / Dividend Distribution (`kovanica-scheduler`)
// ============================================================================

/**
 * Computes deterministic integer pro-rata dividend/coupon payouts across allowlisted,
 * non-frozen holders.
 */
export function computeProRataDividends(params: {
  totalPayoutAtoms: bigint;
  holders: RwaDividendHolder[];
  excludedAddresses?: ReadonlySet<string>;
}): RwaProRataDividendPlan {
  if (params.totalPayoutAtoms <= 0n) {
    throw new RangeError("computeProRataDividends: totalPayoutAtoms must be > 0");
  }
  const eligible = params.holders.filter(
    (h) => h.balance > 0n && !params.excludedAddresses?.has(h.address),
  );
  const eligibleSupply = eligible.reduce((acc, h) => acc + h.balance, 0n);
  if (eligibleSupply === 0n) {
    return {
      totalPayoutAtoms: params.totalPayoutAtoms,
      distributedAtoms: 0n,
      dustRemainderAtoms: params.totalPayoutAtoms,
      eligibleSupply: 0n,
      payouts: [],
    };
  }

  let distributedAtoms = 0n;
  const payouts: RwaDividendPayoutItem[] = eligible.map((h) => {
    const payoutAtoms = (params.totalPayoutAtoms * h.balance) / eligibleSupply;
    const shareBps = Number((h.balance * 10_000n) / eligibleSupply);
    distributedAtoms += payoutAtoms;
    return {
      address: h.address,
      balance: h.balance,
      shareBps,
      payoutAtoms,
    };
  });

  return {
    totalPayoutAtoms: params.totalPayoutAtoms,
    distributedAtoms,
    dustRemainderAtoms: params.totalPayoutAtoms - distributedAtoms,
    eligibleSupply,
    payouts,
  };
}

/** Encodes `rwa_distribute_dividend(payout_token: [u8;32], total_payout: u128, epoch_id: u32, memo: String)`. */
export function buildRwaDividendDistributionCall(params: {
  payoutToken: Uint8Array | string;
  totalPayoutAtoms: bigint | number;
  epochId: number;
  memo?: string;
}): Uint8Array {
  const tokenBytes =
    params.payoutToken === "KVNC" || params.payoutToken === "0".repeat(64)
      ? new Uint8Array(32)
      : parseContractAddress(params.payoutToken);
  return concatBytes([
    tokenBytes,
    u128le(params.totalPayoutAtoms),
    u32le(params.epochId),
    encodeBincodeString((params.memo ?? "").trim()),
  ]);
}

/**
 * Wraps an RWA coupon/dividend distribution payload inside `kovanica-scheduler`'s
 * `scheduler_create_job` Bincode call arguments for recurring automated keeper execution.
 */
export function buildScheduledRwaDividendJobCall(params: {
  rwaContract: Uint8Array | string;
  payoutToken: Uint8Array | string;
  totalPayoutAtoms: bigint | number;
  epochId: number;
  memo?: string;
  executeAfterHeight: bigint | number;
  intervalHeights: bigint | number;
  maxRuns: number;
  bountyPerRun: bigint | number;
}): Uint8Array {
  const rwaBytes = parseContractAddress(params.rwaContract);
  const dividendArgs = buildRwaDividendDistributionCall({
    payoutToken: params.payoutToken,
    totalPayoutAtoms: params.totalPayoutAtoms,
    epochId: params.epochId,
    memo: params.memo,
  });
  return buildSchedulerCreateJobCall({
    targetContract: rwaBytes,
    method: "rwa_distribute_dividend",
    args: dividendArgs,
    executeAfterHeight: params.executeAfterHeight,
    intervalHeights: params.intervalHeights,
    maxRuns: params.maxRuns,
    bountyPerRun: params.bountyPerRun,
  });
}
