/**
 * Typed Bincode 1.x Contract State & Record Decoders and Storage Slot Derivation
 *
 * Verified against canonical Rust contract state layouts in `kovanica-l1`:
 * - `crates/kovanica-htlc/src/lib.rs` (`Htlc`)
 * - `crates/kovanica-vault/src/lib.rs` (`Vault`, `VestingSchedule`)
 * - `crates/kovanica-multisig/src/lib.rs` (`Multisig`, `PendingTx`)
 * - `crates/kovanica-token/src/lib.rs` (`Token`, `TokenV1`, `Pool`)
 * - `crates/kovanica-name-registry/src/lib.rs` (`NameEntry`)
 * - `crates/kovanica-nft/src/lib.rs` (`NftState`, `TokenRecord`)
 * - `crates/kovanica-escrow/src/lib.rs` (`Escrow`)
 */

import { blake3 } from "@noble/hashes/blake3.js";
import { encodeAddress } from "./address";
import { bytesToHex, concatBytes, hexToBytes, parseContractAddress, u64le } from "./contracts";
import { KovanicaError } from "./errors";
import type { HexString, KovanicaAddress, RequestOptions } from "./types";

// --- Constants ---

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB
const DEFAULT_MAX_COLLECTION_COUNT = 100_000;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export const STORAGE_KEY_PREFIXES = {
  STATE: "kvnc/v1/state",
  POOL: "kvnc/v1/pool",
  LP: "kvnc/v1/lp/",
  HTLC: "kvnc/v1/htlc/",
  VAULT: "kvnc/v1/vault/",
  MULTISIG_TX: "kvnc/v1/mtx/",
  NAME: "kvnc/v1/name/",
  ESCROW: "kvnc/v1/escrow/",
} as const;

// --- Typed Decode Error ---

export type DecodeErrorCode =
  | "TRUNCATED"
  | "TRAILING_BYTES"
  | "INVALID_BOOL"
  | "INVALID_VARIANT"
  | "INVALID_UTF8"
  | "LENGTH_OVERFLOW"
  | "INVALID_INPUT";

export class KovanicaDecodeError extends KovanicaError {
  readonly code: DecodeErrorCode;
  readonly offset?: number;
  readonly field?: string;

  constructor(
    code: DecodeErrorCode,
    message: string,
    options?: { offset?: number; field?: string },
  ) {
    super(message);
    this.name = "KovanicaDecodeError";
    this.code = code;
    this.offset = options?.offset;
    this.field = options?.field;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// --- Input Normalization ---

function toBytes(input: Uint8Array | string, context: string): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (typeof input === "string") {
    const clean = input.trim();
    const hex = clean.startsWith("0x") || clean.startsWith("0X") ? clean.slice(2) : clean;
    if (hex.length === 0) {
      return new Uint8Array(0);
    }
    if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new KovanicaDecodeError(
        "INVALID_INPUT",
        `${context}: invalid hex string`,
      );
    }
    return hexToBytes(hex);
  }
  throw new KovanicaDecodeError(
    "INVALID_INPUT",
    `${context}: expected Uint8Array or hex string`,
  );
}

// --- Bounds-Checked Bincode 1.x Reader ---

/**
 * Bounds-checked little-endian Bincode 1.x binary reader.
 *
 * Fails closed with `KovanicaDecodeError` on out-of-bounds reads, invalid
 * boolean values, invalid UTF-8 sequences, oversized length prefixes, or
 * unexpected trailing bytes.
 */
export class BincodeReader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private pos = 0;

  constructor(bytes: Uint8Array) {
    if (!(bytes instanceof Uint8Array)) {
      throw new KovanicaDecodeError(
        "INVALID_INPUT",
        "BincodeReader requires a Uint8Array",
      );
    }
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Current byte cursor offset. */
  get offset(): number {
    return this.pos;
  }

  /** Number of unread bytes remaining in the buffer. */
  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  /** True when all bytes in the buffer have been consumed. */
  isEof(): boolean {
    return this.pos === this.bytes.length;
  }

  /** Fails closed if any trailing bytes remain after decoding a record. */
  assertEof(context = "bincode record"): void {
    if (this.remaining !== 0) {
      throw new KovanicaDecodeError(
        "TRAILING_BYTES",
        `${context}: unexpected ${this.remaining} trailing byte(s) at offset ${this.pos}`,
        { offset: this.pos, field: context },
      );
    }
  }

  private ensureAvailable(size: number, field?: string): void {
    if (!Number.isInteger(size) || size < 0) {
      throw new KovanicaDecodeError(
        "INVALID_INPUT",
        `Invalid read size: ${size}`,
        { offset: this.pos, field },
      );
    }
    if (size > this.remaining) {
      throw new KovanicaDecodeError(
        "TRUNCATED",
        `Unexpected end of buffer${field ? ` reading ${field}` : ""}: needed ${size} byte(s) at offset ${this.pos}, only ${this.remaining} remaining`,
        { offset: this.pos, field },
      );
    }
  }

  readU8(field?: string): number {
    this.ensureAvailable(1, field ?? "u8");
    const val = this.bytes[this.pos]!;
    this.pos += 1;
    return val;
  }

  readU16(field?: string): number {
    this.ensureAvailable(2, field ?? "u16");
    const val = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return val;
  }

  readU32(field?: string): number {
    this.ensureAvailable(4, field ?? "u32");
    const val = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return val;
  }

  readU64(field?: string): bigint {
    this.ensureAvailable(8, field ?? "u64");
    const val = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return val;
  }

  readU128(field?: string): bigint {
    this.ensureAvailable(16, field ?? "u128");
    const low = this.view.getBigUint64(this.pos, true);
    const high = this.view.getBigUint64(this.pos + 8, true);
    this.pos += 16;
    return low | (high << 64n);
  }

  readBool(field?: string): boolean {
    const startOffset = this.pos;
    const raw = this.readU8(field ?? "bool");
    if (raw === 0) return false;
    if (raw === 1) return true;
    throw new KovanicaDecodeError(
      "INVALID_BOOL",
      `Invalid boolean byte 0x${raw.toString(16).padStart(2, "0")}${field ? ` for ${field}` : ""} at offset ${startOffset}`,
      { offset: startOffset, field: field ?? "bool" },
    );
  }

  readFixedBytes(n: number, field?: string): Uint8Array {
    this.ensureAvailable(n, field ?? `bytes[${n}]`);
    const slice = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  readBytes(maxLen = DEFAULT_MAX_BYTES, field?: string): Uint8Array {
    const startOffset = this.pos;
    const len = this.readU64(field ? `${field}.length` : "bytes.length");
    if (len > BigInt(maxLen)) {
      throw new KovanicaDecodeError(
        "LENGTH_OVERFLOW",
        `Byte length ${len} exceeds maximum allowed ${maxLen}${field ? ` for ${field}` : ""} at offset ${startOffset}`,
        { offset: startOffset, field: field ?? "bytes" },
      );
    }
    if (len > BigInt(this.remaining)) {
      throw new KovanicaDecodeError(
        "TRUNCATED",
        `Unexpected end of buffer${field ? ` reading ${field}` : ""}: length prefix ${len} exceeds ${this.remaining} remaining byte(s) at offset ${this.pos}`,
        { offset: this.pos, field: field ?? "bytes" },
      );
    }
    return this.readFixedBytes(Number(len), field ?? "bytes");
  }

  readString(maxLen = DEFAULT_MAX_BYTES, field?: string): string {
    const startOffset = this.pos;
    const raw = this.readBytes(maxLen, field ?? "string");
    try {
      return UTF8_DECODER.decode(raw);
    } catch {
      throw new KovanicaDecodeError(
        "INVALID_UTF8",
        `Invalid UTF-8 sequence${field ? ` in ${field}` : ""} at offset ${startOffset}`,
        { offset: startOffset, field: field ?? "string" },
      );
    }
  }

  readOption<T>(readInner: () => T, field?: string): T | null {
    const startOffset = this.pos;
    const tag = this.readU8(field ? `${field}.tag` : "option.tag");
    if (tag === 0) return null;
    if (tag === 1) return readInner();
    throw new KovanicaDecodeError(
      "INVALID_VARIANT",
      `Invalid Option tag ${tag}${field ? ` for ${field}` : ""} at offset ${startOffset}`,
      { offset: startOffset, field: field ?? "option" },
    );
  }

  readVec<T>(
    readItem: (index: number) => T,
    maxCount = DEFAULT_MAX_COLLECTION_COUNT,
    field?: string,
  ): T[] {
    const startOffset = this.pos;
    const count = this.readU64(field ? `${field}.count` : "vec.count");
    if (count > BigInt(maxCount)) {
      throw new KovanicaDecodeError(
        "LENGTH_OVERFLOW",
        `Collection count ${count} exceeds maximum allowed ${maxCount}${field ? ` for ${field}` : ""} at offset ${startOffset}`,
        { offset: startOffset, field: field ?? "vec" },
      );
    }
    const num = Number(count);
    const items: T[] = [];
    for (let i = 0; i < num; i += 1) {
      items.push(readItem(i));
    }
    return items;
  }
}

// --- Decoded Contract Record Types ---

export type HtlcStatus = "open" | "claimed" | "refunded";

export interface HtlcRecord {
  sender: Uint8Array;
  senderHex: string;
  claimer: Uint8Array;
  claimerHex: string;
  amount: bigint;
  hashLock: Uint8Array;
  hashLockHex: string;
  expiry: bigint;
  claimed: boolean;
  refunded: boolean;
  status: HtlcStatus;
}

export type VaultSchedule =
  | { kind: "absolute"; unlockAt: bigint }
  | { kind: "linear"; start: bigint; end: bigint; cliff: bigint | null };

export interface VaultRecord {
  creator: Uint8Array;
  creatorHex: string;
  beneficiary: Uint8Array;
  beneficiaryHex: string;
  totalAmount: bigint;
  claimedAmount: bigint;
  schedule: VaultSchedule;
  startHeight: bigint;
  cliffHeight: bigint | null;
  endHeight: bigint;
  cancelled: boolean;
}

export interface MultisigState {
  owners: Uint8Array[];
  ownersHex: string[];
  threshold: number;
  nextTxId: bigint;
}

export interface MultisigPendingTx {
  id: bigint;
  to: Uint8Array;
  toHex: string;
  amount: bigint;
  data: Uint8Array;
  dataHex: string;
  confirmations: Uint8Array[];
  confirmationsHex: string[];
  executed: boolean;
}

export interface TokenBalanceEntry {
  account: Uint8Array;
  accountHex: string;
  amount: bigint;
}

export interface TokenAllowanceEntry {
  owner: Uint8Array;
  ownerHex: string;
  spender: Uint8Array;
  spenderHex: string;
  amount: bigint;
}

export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  owner: Uint8Array;
  ownerHex: string;
  minter: Uint8Array;
  minterHex: string;
  balances: TokenBalanceEntry[];
  allowances: TokenAllowanceEntry[];
  paused: boolean;
  icon: string;
}

export interface TokenPoolState {
  kunaReserve: bigint;
  tokenReserve: bigint;
  feeBps: number;
  lpTotal: bigint;
  paused: boolean;
}

export interface NameRecord {
  owner: Uint8Array;
  ownerHex: string;
  pubkey: Uint8Array;
  pubkeyHex: string;
  relayEndpoints: string[];
}

export interface NftTokenEntry {
  tokenId: bigint;
  owner: Uint8Array;
  ownerHex: string;
  approved: Uint8Array | null;
  approvedHex: string | null;
  tokenUri: string;
}

export interface NftMetadata {
  name: string;
  symbol: string;
  baseUri: string;
  owner: Uint8Array;
  ownerHex: string;
  minter: Uint8Array;
  minterHex: string;
  tokens: NftTokenEntry[];
}

export type EscrowStatus = "open" | "released" | "refunded";

export interface EscrowRecord {
  creator: Uint8Array;
  creatorHex: string;
  parties: Uint8Array[];
  partiesHex: string[];
  threshold: number;
  approvals: Uint8Array[];
  approvalsHex: string[];
  amount: bigint;
  deadline: bigint;
  released: boolean;
  refunded: boolean;
  status: EscrowStatus;
}

// --- Canonical Contract Record Decoders ---

/**
 * Decodes a canonical `kovanica-htlc::Htlc` bincode record.
 *
 * Wire layout (122 bytes):
 * `sender([u8;32]) || claimer([u8;32]) || amount(u128) || hash_lock([u8;32]) || expiry(u64) || claimed(bool) || refunded(bool)`
 */
export function decodeHtlcRecord(input: Uint8Array | string): HtlcRecord {
  const reader = new BincodeReader(toBytes(input, "decodeHtlcRecord"));
  const sender = reader.readFixedBytes(32, "Htlc.sender");
  const claimer = reader.readFixedBytes(32, "Htlc.claimer");
  const amount = reader.readU128("Htlc.amount");
  const hashLock = reader.readFixedBytes(32, "Htlc.hash_lock");
  const expiry = reader.readU64("Htlc.expiry");
  const claimed = reader.readBool("Htlc.claimed");
  const refunded = reader.readBool("Htlc.refunded");
  reader.assertEof("Htlc");

  if (claimed && refunded) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "Htlc record cannot be both claimed and refunded",
      { field: "Htlc.status" },
    );
  }

  const status: HtlcStatus = claimed ? "claimed" : refunded ? "refunded" : "open";
  return {
    sender,
    senderHex: bytesToHex(sender),
    claimer,
    claimerHex: bytesToHex(claimer),
    amount,
    hashLock,
    hashLockHex: bytesToHex(hashLock),
    expiry,
    claimed,
    refunded,
    status,
  };
}

/**
 * Decodes a canonical `kovanica-vault::Vault` bincode record.
 *
 * Wire layout:
 * `creator([u8;32]) || beneficiary([u8;32]) || total(u128) || claimed(u128) || schedule(VestingSchedule) || cancelled(bool)`
 *
 * Where `VestingSchedule` is:
 * - Variant `0u32`: `Absolute { unlock_at: u64 }`
 * - Variant `1u32`: `Linear { start: u64, end: u64, cliff: Option<u64> }`
 */
export function decodeVaultRecord(input: Uint8Array | string): VaultRecord {
  const reader = new BincodeReader(toBytes(input, "decodeVaultRecord"));
  const creator = reader.readFixedBytes(32, "Vault.creator");
  const beneficiary = reader.readFixedBytes(32, "Vault.beneficiary");
  const totalAmount = reader.readU128("Vault.total");
  const claimedAmount = reader.readU128("Vault.claimed");

  const variantOffset = reader.offset;
  const variant = reader.readU32("Vault.schedule.variant");
  let schedule: VaultSchedule;
  let startHeight: bigint;
  let cliffHeight: bigint | null;
  let endHeight: bigint;

  if (variant === 0) {
    const unlockAt = reader.readU64("Vault.schedule.unlock_at");
    schedule = { kind: "absolute", unlockAt };
    startHeight = unlockAt;
    cliffHeight = null;
    endHeight = unlockAt;
  } else if (variant === 1) {
    const start = reader.readU64("Vault.schedule.start");
    const end = reader.readU64("Vault.schedule.end");
    const cliff = reader.readOption(
      () => reader.readU64("Vault.schedule.cliff"),
      "Vault.schedule.cliff",
    );
    schedule = { kind: "linear", start, end, cliff };
    startHeight = start;
    cliffHeight = cliff;
    endHeight = end;
  } else {
    throw new KovanicaDecodeError(
      "INVALID_VARIANT",
      `Unknown VestingSchedule variant ${variant} at offset ${variantOffset}`,
      { offset: variantOffset, field: "Vault.schedule" },
    );
  }

  const cancelled = reader.readBool("Vault.cancelled");
  reader.assertEof("Vault");

  return {
    creator,
    creatorHex: bytesToHex(creator),
    beneficiary,
    beneficiaryHex: bytesToHex(beneficiary),
    totalAmount,
    claimedAmount,
    schedule,
    startHeight,
    cliffHeight,
    endHeight,
    cancelled,
  };
}

/**
 * Decodes a canonical `kovanica-multisig::Multisig` singleton state record.
 *
 * Wire layout:
 * `owners(BTreeSet<[u8;32]>) || threshold(u32) || next_tx_id(u64)`
 */
export function decodeMultisigState(input: Uint8Array | string): MultisigState {
  const reader = new BincodeReader(toBytes(input, "decodeMultisigState"));
  const owners = reader.readVec(
    (i) => reader.readFixedBytes(32, `Multisig.owners[${i}]`),
    1_000,
    "Multisig.owners",
  );
  const threshold = reader.readU32("Multisig.threshold");
  const nextTxId = reader.readU64("Multisig.next_tx_id");
  reader.assertEof("Multisig");

  return {
    owners,
    ownersHex: owners.map(bytesToHex),
    threshold,
    nextTxId,
  };
}

/**
 * Decodes a canonical `kovanica-multisig::PendingTx` record.
 *
 * Wire layout:
 * `id(u64) || to([u8;32]) || amount(u128) || data(Vec<u8>) || confirmations(BTreeSet<[u8;32]>) || executed(bool)`
 */
export function decodeMultisigPendingTx(input: Uint8Array | string): MultisigPendingTx {
  const reader = new BincodeReader(toBytes(input, "decodeMultisigPendingTx"));
  const id = reader.readU64("PendingTx.id");
  const to = reader.readFixedBytes(32, "PendingTx.to");
  const amount = reader.readU128("PendingTx.amount");
  const data = reader.readBytes(DEFAULT_MAX_BYTES, "PendingTx.data");
  const confirmations = reader.readVec(
    (i) => reader.readFixedBytes(32, `PendingTx.confirmations[${i}]`),
    1_000,
    "PendingTx.confirmations",
  );
  const executed = reader.readBool("PendingTx.executed");
  reader.assertEof("PendingTx");

  return {
    id,
    to,
    toHex: bytesToHex(to),
    amount,
    data,
    dataHex: bytesToHex(data),
    confirmations,
    confirmationsHex: confirmations.map(bytesToHex),
    executed,
  };
}

/**
 * Decodes a canonical `kovanica-token::Token` (v2 with `icon`, or v1 pre-`icon`) singleton state record.
 *
 * Wire layout:
 * `name(String) || symbol(String) || decimals(u8) || total_supply(u128) || owner([u8;32]) || minter([u8;32]) || balances(BTreeMap<[u8;32], u128>) || allowances(BTreeMap<([u8;32], [u8;32]), u128>) || paused(bool) [|| icon(String)]`
 */
export function decodeTokenMetadata(input: Uint8Array | string): TokenMetadata {
  const reader = new BincodeReader(toBytes(input, "decodeTokenMetadata"));
  const name = reader.readString(DEFAULT_MAX_BYTES, "Token.name");
  const symbol = reader.readString(DEFAULT_MAX_BYTES, "Token.symbol");
  const decimals = reader.readU8("Token.decimals");
  const totalSupply = reader.readU128("Token.total_supply");
  const owner = reader.readFixedBytes(32, "Token.owner");
  const minter = reader.readFixedBytes(32, "Token.minter");

  const balances = reader.readVec<TokenBalanceEntry>(
    (i) => {
      const account = reader.readFixedBytes(32, `Token.balances[${i}].account`);
      const amount = reader.readU128(`Token.balances[${i}].amount`);
      return { account, accountHex: bytesToHex(account), amount };
    },
    DEFAULT_MAX_COLLECTION_COUNT,
    "Token.balances",
  );

  const allowances = reader.readVec<TokenAllowanceEntry>(
    (i) => {
      const allowanceOwner = reader.readFixedBytes(32, `Token.allowances[${i}].owner`);
      const spender = reader.readFixedBytes(32, `Token.allowances[${i}].spender`);
      const amount = reader.readU128(`Token.allowances[${i}].amount`);
      return {
        owner: allowanceOwner,
        ownerHex: bytesToHex(allowanceOwner),
        spender,
        spenderHex: bytesToHex(spender),
        amount,
      };
    },
    DEFAULT_MAX_COLLECTION_COUNT,
    "Token.allowances",
  );

  const paused = reader.readBool("Token.paused");
  // TokenV1 ends immediately after `paused`; Token (v2) appends `icon: String`.
  const icon = reader.remaining === 0 ? "" : reader.readString(DEFAULT_MAX_BYTES, "Token.icon");
  reader.assertEof("Token");

  return {
    name,
    symbol,
    decimals,
    totalSupply,
    owner,
    ownerHex: bytesToHex(owner),
    minter,
    minterHex: bytesToHex(minter),
    balances,
    allowances,
    paused,
    icon,
  };
}

/** Alias for `decodeTokenMetadata`. */
export const decodeTokenState = decodeTokenMetadata;

/**
 * Decodes a canonical `kovanica-token::Pool` singleton state record.
 *
 * Wire layout (51 bytes):
 * `kuna_reserve(u128) || token_reserve(u128) || fee_bps(u16) || lp_total(u128) || paused(bool)`
 */
export function decodeTokenPool(input: Uint8Array | string): TokenPoolState {
  const reader = new BincodeReader(toBytes(input, "decodeTokenPool"));
  const kunaReserve = reader.readU128("Pool.kuna_reserve");
  const tokenReserve = reader.readU128("Pool.token_reserve");
  const feeBps = reader.readU16("Pool.fee_bps");
  const lpTotal = reader.readU128("Pool.lp_total");
  const paused = reader.readBool("Pool.paused");
  reader.assertEof("Pool");

  return {
    kunaReserve,
    tokenReserve,
    feeBps,
    lpTotal,
    paused,
  };
}

/**
 * Decodes a canonical `kovanica-name-registry::NameEntry` bincode record.
 *
 * Wire layout:
 * `owner([u8;32]) || pubkey([u8;32]) || relay_endpoints(Vec<String>)`
 */
export function decodeNameRecord(input: Uint8Array | string): NameRecord {
  const reader = new BincodeReader(toBytes(input, "decodeNameRecord"));
  const owner = reader.readFixedBytes(32, "NameEntry.owner");
  const pubkey = reader.readFixedBytes(32, "NameEntry.pubkey");
  const relayEndpoints = reader.readVec(
    (i) => reader.readString(DEFAULT_MAX_BYTES, `NameEntry.relay_endpoints[${i}]`),
    DEFAULT_MAX_COLLECTION_COUNT,
    "NameEntry.relay_endpoints",
  );
  reader.assertEof("NameEntry");

  return {
    owner,
    ownerHex: bytesToHex(owner),
    pubkey,
    pubkeyHex: bytesToHex(pubkey),
    relayEndpoints,
  };
}

/**
 * Decodes a canonical `kovanica-nft::NftState` singleton state record.
 *
 * Wire layout:
 * `name(String) || symbol(String) || base_uri(String) || owner([u8;32]) || minter([u8;32]) || tokens(BTreeMap<u128, TokenRecord>)`
 *
 * Where `TokenRecord` is `owner([u8;32]) || approved(Option<[u8;32]>) || token_uri(String)`.
 */
export function decodeNftMetadata(input: Uint8Array | string): NftMetadata {
  const reader = new BincodeReader(toBytes(input, "decodeNftMetadata"));
  const name = reader.readString(DEFAULT_MAX_BYTES, "NftState.name");
  const symbol = reader.readString(DEFAULT_MAX_BYTES, "NftState.symbol");
  const baseUri = reader.readString(DEFAULT_MAX_BYTES, "NftState.base_uri");
  const owner = reader.readFixedBytes(32, "NftState.owner");
  const minter = reader.readFixedBytes(32, "NftState.minter");

  const tokens = reader.readVec<NftTokenEntry>(
    (i) => {
      const tokenId = reader.readU128(`NftState.tokens[${i}].token_id`);
      const tokenOwner = reader.readFixedBytes(32, `NftState.tokens[${i}].owner`);
      const approved = reader.readOption(
        () => reader.readFixedBytes(32, `NftState.tokens[${i}].approved`),
        `NftState.tokens[${i}].approved`,
      );
      const tokenUri = reader.readString(DEFAULT_MAX_BYTES, `NftState.tokens[${i}].token_uri`);
      return {
        tokenId,
        owner: tokenOwner,
        ownerHex: bytesToHex(tokenOwner),
        approved,
        approvedHex: approved ? bytesToHex(approved) : null,
        tokenUri,
      };
    },
    DEFAULT_MAX_COLLECTION_COUNT,
    "NftState.tokens",
  );
  reader.assertEof("NftState");

  return {
    name,
    symbol,
    baseUri,
    owner,
    ownerHex: bytesToHex(owner),
    minter,
    minterHex: bytesToHex(minter),
    tokens,
  };
}

/** Alias for `decodeNftMetadata`. */
export const decodeNftState = decodeNftMetadata;

/**
 * Decodes a canonical `kovanica-escrow::Escrow` bincode record.
 *
 * Wire layout:
 * `creator([u8;32]) || parties(Vec<[u8;32]>) || threshold(u8) || approvals(Vec<[u8;32]>) || amount(u128) || deadline(u64) || released(bool) || refunded(bool)`
 */
export function decodeEscrowRecord(input: Uint8Array | string): EscrowRecord {
  const reader = new BincodeReader(toBytes(input, "decodeEscrowRecord"));
  const creator = reader.readFixedBytes(32, "Escrow.creator");
  const parties = reader.readVec(
    (i) => reader.readFixedBytes(32, `Escrow.parties[${i}]`),
    1_000,
    "Escrow.parties",
  );
  const threshold = reader.readU8("Escrow.threshold");
  const approvals = reader.readVec(
    (i) => reader.readFixedBytes(32, `Escrow.approvals[${i}]`),
    1_000,
    "Escrow.approvals",
  );
  const amount = reader.readU128("Escrow.amount");
  const deadline = reader.readU64("Escrow.deadline");
  const released = reader.readBool("Escrow.released");
  const refunded = reader.readBool("Escrow.refunded");
  reader.assertEof("Escrow");

  if (released && refunded) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "Escrow record cannot be both released and refunded",
      { field: "Escrow.status" },
    );
  }

  const status: EscrowStatus = released ? "released" : refunded ? "refunded" : "open";
  return {
    creator,
    creatorHex: bytesToHex(creator),
    parties,
    partiesHex: parties.map(bytesToHex),
    threshold,
    approvals,
    approvalsHex: approvals.map(bytesToHex),
    amount,
    deadline,
    released,
    refunded,
    status,
  };
}

// --- Typed Contract Log / Record Dispatcher (`decodeContractLog`) ---

export type ContractLogKind =
  | "htlc"
  | "vault"
  | "multisig_state"
  | "multisig_tx"
  | "token_metadata"
  | "token_pool"
  | "name"
  | "nft_metadata"
  | "escrow";

export type DecodedContractLog =
  | { kind: "htlc"; record: HtlcRecord }
  | { kind: "vault"; record: VaultRecord }
  | { kind: "multisig_state"; record: MultisigState }
  | { kind: "multisig_tx"; record: MultisigPendingTx }
  | { kind: "token_metadata"; record: TokenMetadata }
  | { kind: "token_pool"; record: TokenPoolState }
  | { kind: "name"; record: NameRecord }
  | { kind: "nft_metadata"; record: NftMetadata }
  | { kind: "escrow"; record: EscrowRecord };

export type DecodedContractLogByKind<K extends ContractLogKind> = Extract<
  DecodedContractLog,
  { kind: K }
>;

/**
 * Decodes a canonical Bincode contract log/event or state payload (`Uint8Array` or `0x`/raw hex string,
 * such as `WsExecutionEvent.data`) into a typed discriminated union `{ kind, record }`.
 *
 * Fails closed with {@link KovanicaDecodeError} on unknown `kind` (`INVALID_INPUT`), invalid hex,
 * truncated payloads, invalid variants/booleans, or trailing bytes.
 */
export function decodeContractLog<K extends ContractLogKind>(
  logDataHexOrBytes: Uint8Array | string,
  kind: K,
): DecodedContractLogByKind<K>;
export function decodeContractLog(
  logDataHexOrBytes: Uint8Array | string,
  kind: ContractLogKind,
): DecodedContractLog;
export function decodeContractLog(
  logDataHexOrBytes: Uint8Array | string,
  kind: ContractLogKind,
): DecodedContractLog {
  switch (kind) {
    case "htlc":
      return { kind: "htlc", record: decodeHtlcRecord(logDataHexOrBytes) };
    case "vault":
      return { kind: "vault", record: decodeVaultRecord(logDataHexOrBytes) };
    case "multisig_state":
      return { kind: "multisig_state", record: decodeMultisigState(logDataHexOrBytes) };
    case "multisig_tx":
      return { kind: "multisig_tx", record: decodeMultisigPendingTx(logDataHexOrBytes) };
    case "token_metadata":
      return { kind: "token_metadata", record: decodeTokenMetadata(logDataHexOrBytes) };
    case "token_pool":
      return { kind: "token_pool", record: decodeTokenPool(logDataHexOrBytes) };
    case "name":
      return { kind: "name", record: decodeNameRecord(logDataHexOrBytes) };
    case "nft_metadata":
      return { kind: "nft_metadata", record: decodeNftMetadata(logDataHexOrBytes) };
    case "escrow":
      return { kind: "escrow", record: decodeEscrowRecord(logDataHexOrBytes) };
    default: {
      const exhaustive: never = kind;
      throw new KovanicaDecodeError(
        "INVALID_INPUT",
        `Unknown contract log kind: ${String(exhaustive)}`,
        { field: "kind" },
      );
    }
  }
}

// --- Transaction Receipt Log Batch Decoder (`decodeTransactionReceiptLogs`) ---

const VALID_CONTRACT_LOG_KINDS: ReadonlySet<ContractLogKind> = new Set<ContractLogKind>([
  "htlc",
  "vault",
  "multisig_state",
  "multisig_tx",
  "token_metadata",
  "token_pool",
  "name",
  "nft_metadata",
  "escrow",
]);

/** Individual raw log entry inside a transaction receipt. */
export interface ReceiptLogEntry {
  address?: string;
  topics?: ReadonlyArray<string>;
  data: string | Uint8Array;
}

/** Minimal receipt interface accepted by {@link decodeTransactionReceiptLogs}. */
export interface ReceiptWithLogs {
  logs?: ReadonlyArray<ReceiptLogEntry> | null;
}

/**
 * Resolver callback that inspects a receipt log and its 0-based index in `receipt.logs`
 * and returns the {@link ContractLogKind} to decode it with, or `null` / `undefined` to skip it.
 */
export type ContractLogKindResolver<K extends ContractLogKind = ContractLogKind> = (
  log: ReceiptLogEntry,
  index: number,
) => K | null | undefined;

/**
 * Decoded transaction receipt log entry narrowed by a specific {@link ContractLogKind} subset `K`.
 */
export type DecodedTransactionReceiptLogByKind<K extends ContractLogKind> = {
  [P in K]: {
    index: number;
    address?: string;
    topics?: ReadonlyArray<string>;
    kind: P;
    record: DecodedContractLogByKind<P>["record"];
  };
}[K];

/**
 * Discriminated union of all decoded transaction receipt log entries.
 */
export type DecodedTransactionReceiptLog =
  DecodedTransactionReceiptLogByKind<ContractLogKind>;

/**
 * Decodes matching logs from a transaction receipt via {@link decodeContractLog}.
 *
 * - Accepts a receipt object with `logs?: ReadonlyArray<{ address?: string; topics?: ReadonlyArray<string>; data: string | Uint8Array }>`
 *   and either a single {@link ContractLogKind} or a resolver `(log, index) => ContractLogKind | null | undefined`.
 * - When a resolver returns `null` or `undefined` for a log, that log is skipped while preserving the original
 *   0-based `index` of matching logs.
 * - Returns an array of `{ index, address?, topics?, kind, record }`.
 * - Fails closed with {@link KovanicaDecodeError} if `receipt`, `kindOrResolver`, or any matched log payload is malformed.
 */
export function decodeTransactionReceiptLogs<K extends ContractLogKind>(
  receipt: ReceiptWithLogs,
  kindOrResolver: K | ContractLogKindResolver<K>,
): Array<DecodedTransactionReceiptLogByKind<K>>;
export function decodeTransactionReceiptLogs(
  receipt: ReceiptWithLogs,
  kindOrResolver: ContractLogKind | ContractLogKindResolver,
): DecodedTransactionReceiptLog[];
export function decodeTransactionReceiptLogs(
  receipt: ReceiptWithLogs,
  kindOrResolver: ContractLogKind | ContractLogKindResolver,
): DecodedTransactionReceiptLog[] {
  if (!receipt || typeof receipt !== "object") {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "decodeTransactionReceiptLogs: expected a receipt object",
      { field: "receipt" },
    );
  }

  const isResolver = typeof kindOrResolver === "function";
  if (!isResolver) {
    if (
      typeof kindOrResolver !== "string" ||
      !VALID_CONTRACT_LOG_KINDS.has(kindOrResolver)
    ) {
      throw new KovanicaDecodeError(
        "INVALID_INPUT",
        `Unknown contract log kind: ${String(kindOrResolver)}`,
        { field: "kindOrResolver" },
      );
    }
  }

  if (receipt.logs === undefined || receipt.logs === null) {
    return [];
  }

  if (!Array.isArray(receipt.logs)) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "decodeTransactionReceiptLogs: receipt.logs must be an array when provided",
      { field: "receipt.logs" },
    );
  }

  const decodedLogs: DecodedTransactionReceiptLog[] = [];
  for (let i = 0; i < receipt.logs.length; i += 1) {
    const log = receipt.logs[i];
    if (!log || typeof log !== "object") {
      throw new KovanicaDecodeError(
        "INVALID_INPUT",
        `decodeTransactionReceiptLogs: invalid log entry at index ${i}`,
        { field: `receipt.logs[${i}]` },
      );
    }

    const kind = isResolver ? kindOrResolver(log, i) : kindOrResolver;
    if (kind === null || kind === undefined) {
      continue;
    }

    const decoded = decodeContractLog(log.data, kind);
    const entry: DecodedTransactionReceiptLog = {
      index: i,
      ...(log.address !== undefined ? { address: log.address } : {}),
      ...(log.topics !== undefined ? { topics: log.topics } : {}),
      kind: decoded.kind,
      record: decoded.record,
    } as DecodedTransactionReceiptLog;

    decodedLogs.push(entry);
  }

  return decodedLogs;
}

// --- Storage Slot Key Derivation Helpers ---

export type StorageSlotContract =
  | "state"
  | "token"
  | "token_pool"
  | "token_lp"
  | "nft"
  | "multisig"
  | "multisig_tx"
  | "htlc"
  | "vault"
  | "name"
  | "escrow";

/** Alias for {@link StorageSlotContract}. */
export type StorageSlotKind = StorageSlotContract;

export type StorageSlotKey = Uint8Array | string | bigint | number;

function parseFixed32Key(key: StorageSlotKey | undefined, label: string): Uint8Array {
  if (key === undefined) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      `${label} requires a 32-byte key`,
    );
  }
  if (typeof key === "bigint" || typeof key === "number") {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      `${label} requires a 32-byte Uint8Array or 64-char hex string`,
    );
  }
  const bytes = toBytes(key, label);
  if (bytes.length !== 32) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      `${label} requires exactly 32 bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

/**
 * Derives a raw 32-byte BLAKE3 storage slot: `blake3(prefix || key)`.
 */
export function derivePrefixedStorageSlot(
  prefix: string | Uint8Array,
  key?: Uint8Array | string,
): Uint8Array {
  const prefixBytes = typeof prefix === "string" ? UTF8_ENCODER.encode(prefix) : prefix;
  if (key === undefined) {
    return blake3(prefixBytes);
  }
  const keyBytes = typeof key === "string" ? UTF8_ENCODER.encode(key) : key;
  return blake3(concatBytes([prefixBytes, keyBytes]));
}

/**
 * Derives the canonical 32-byte BLAKE3 storage slot for `kovanica_getStorageAt`.
 *
 * Supported contracts:
 * - `"state" | "token" | "nft" | "multisig"`: `blake3("kvnc/v1/state")` (no key)
 * - `"token_pool"`: `blake3("kvnc/v1/pool")` (no key)
 * - `"token_lp"`: `blake3("kvnc/v1/lp/" || address32)`
 * - `"htlc"`: `blake3("kvnc/v1/htlc/" || swapId32)`
 * - `"vault"`: `blake3("kvnc/v1/vault/" || vaultId32)`
 * - `"multisig_tx"`: `blake3("kvnc/v1/mtx/" || u64le(txId))`
 * - `"name"`: `blake3("kvnc/v1/name/" || utf8(lowercaseName))`
 * - `"escrow"`: `blake3("kvnc/v1/escrow/" || escrowId32)`
 */
export function deriveStorageSlot(
  contract: StorageSlotContract,
  key?: StorageSlotKey,
): Uint8Array {
  switch (contract) {
    case "state":
    case "token":
    case "nft":
    case "multisig":
      return derivePrefixedStorageSlot(STORAGE_KEY_PREFIXES.STATE);

    case "token_pool":
      return derivePrefixedStorageSlot(STORAGE_KEY_PREFIXES.POOL);

    case "token_lp":
      return derivePrefixedStorageSlot(
        STORAGE_KEY_PREFIXES.LP,
        parseFixed32Key(key, "deriveStorageSlot(token_lp)"),
      );

    case "htlc":
      return derivePrefixedStorageSlot(
        STORAGE_KEY_PREFIXES.HTLC,
        parseFixed32Key(key, "deriveStorageSlot(htlc)"),
      );

    case "vault":
      return derivePrefixedStorageSlot(
        STORAGE_KEY_PREFIXES.VAULT,
        parseFixed32Key(key, "deriveStorageSlot(vault)"),
      );

    case "multisig_tx": {
      if (key === undefined) {
        throw new KovanicaDecodeError(
          "INVALID_INPUT",
          "deriveStorageSlot(multisig_tx) requires a u64 txId",
        );
      }
      if (key instanceof Uint8Array) {
        if (key.length !== 8) {
          throw new KovanicaDecodeError(
            "INVALID_INPUT",
            `deriveStorageSlot(multisig_tx) Uint8Array key must be 8 bytes, got ${key.length}`,
          );
        }
        return derivePrefixedStorageSlot(STORAGE_KEY_PREFIXES.MULTISIG_TX, key);
      }
      if (typeof key === "string") {
        throw new KovanicaDecodeError(
          "INVALID_INPUT",
          "deriveStorageSlot(multisig_tx) requires a bigint, number, or 8-byte Uint8Array",
        );
      }
      return derivePrefixedStorageSlot(STORAGE_KEY_PREFIXES.MULTISIG_TX, u64le(key));
    }

    case "name": {
      if (typeof key !== "string" || key.trim().length === 0) {
        throw new KovanicaDecodeError(
          "INVALID_INPUT",
          "deriveStorageSlot(name) requires a non-empty name string",
        );
      }
      return derivePrefixedStorageSlot(
        STORAGE_KEY_PREFIXES.NAME,
        key.trim().toLowerCase(),
      );
    }

    case "escrow":
      return derivePrefixedStorageSlot(
        STORAGE_KEY_PREFIXES.ESCROW,
        parseFixed32Key(key, "deriveStorageSlot(escrow)"),
      );

    default: {
      const exhaustive: never = contract;
      throw new KovanicaDecodeError(
        "INVALID_INPUT",
        `Unknown storage slot contract: ${String(exhaustive)}`,
      );
    }
  }
}

/**
 * Same as `deriveStorageSlot`, returning a 64-char lowercase hex string suitable for `kovanica_getStorageAt`.
 */
export function deriveStorageSlotHex(
  contract: StorageSlotContract,
  key?: StorageSlotKey,
): string {
  return bytesToHex(deriveStorageSlot(contract, key));
}

// --- Typed Contract Storage Reader (`readContractStorage`) ---

/**
 * Minimal client interface required by {@link readContractStorage}.
 * Satisfied by {@link KovanicaClient}.
 */
export interface ReadContractStorageClient {
  getStorageAt(
    address: string,
    slot: string | number | bigint,
    options?: RequestOptions,
  ): Promise<string>;
}

/**
 * Maps a canonical {@link StorageSlotKind} to its default decoded record type
 * when no explicit `decoder` is supplied to {@link readContractStorage}.
 */
export type DefaultDecodedStorageByKind<K extends StorageSlotKind> = K extends "htlc"
  ? HtlcRecord
  : K extends "vault"
    ? VaultRecord
    : K extends "multisig"
      ? MultisigState
      : K extends "multisig_tx"
        ? MultisigPendingTx
        : K extends "token"
          ? TokenMetadata
          : K extends "token_pool"
            ? TokenPoolState
            : K extends "name"
              ? NameRecord
              : K extends "nft"
                ? NftMetadata
                : K extends "escrow"
                  ? EscrowRecord
                  : undefined;

const DEFAULT_DECODER_KIND_BY_SLOT_KIND: Partial<Record<StorageSlotKind, ContractLogKind>> = {
  htlc: "htlc",
  vault: "vault",
  multisig: "multisig_state",
  multisig_tx: "multisig_tx",
  token: "token_metadata",
  token_pool: "token_pool",
  name: "name",
  nft: "nft_metadata",
  escrow: "escrow",
};

/**
 * Target storage slot selector for {@link readContractStorage}:
 * - `{ slotHex: string; decoder?: ... }`: explicit 32-byte hex slot
 * - `{ kind: StorageSlotKind; key?: StorageSlotKey; decoder?: ... }`: canonical BLAKE3 slot via {@link deriveStorageSlotHex}
 * - `{ prefix: string | Uint8Array; key?: string | Uint8Array; decoder?: ... }`: prefixed BLAKE3 slot via {@link derivePrefixedStorageSlot}
 */
export type ContractStorageTarget<TDecoded = unknown> =
  | {
      slotHex: string;
      decoder?: ContractLogKind | ((bytes: Uint8Array) => TDecoded);
    }
  | {
      kind: StorageSlotKind;
      key?: StorageSlotKey;
      decoder?: ContractLogKind | ((bytes: Uint8Array) => TDecoded);
    }
  | {
      prefix: string | Uint8Array;
      key?: string | Uint8Array;
      decoder?: ContractLogKind | ((bytes: Uint8Array) => TDecoded);
    };

export interface ReadContractStorageOptions {
  /**
   * Optional block number or tag (reserved for forward compatibility; `kovanica_getStorageAt` queries latest committed state).
   */
  blockNumberOrTag?: bigint | number | string;
  /**
   * Optional RPC request options (`timeoutMs`, `signal`) forwarded to `client.getStorageAt`.
   */
  requestOptions?: RequestOptions;
}

export interface ContractStorageReadResult<TDecoded = undefined> {
  /** Validated canonical 64-character PRO-21 contract address (`kvnc...dag`). */
  contract: KovanicaAddress;
  /** Normalized `0x`-prefixed 64-character lowercase hex storage slot key. */
  slotHex: HexString;
  /** Normalized `0x`-prefixed lowercase hex value (`"0x"` when `isEmpty` is `true`). */
  rawHex: HexString;
  /** Raw storage value bytes (`new Uint8Array(0)` when `isEmpty` is `true`). */
  rawBytes: Uint8Array;
  /** True when the storage slot is empty (`null`, `"0x"`, `"0x0"`, or 32 zero bytes). */
  isEmpty: boolean;
  /** Decoded Bincode record when `isEmpty` is `false` and a decoder (or default `kind` decoder) is applicable. */
  decoded?: TDecoded;
}

function normalizeAndValidateSlotHex(slotHex: string): string {
  if (typeof slotHex !== "string") {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "readContractStorage: slotHex must be a 32-byte hex string",
      { field: "slotHex" },
    );
  }
  const trimmed = slotHex.trim();
  const clean =
    trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  if (clean.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      `readContractStorage: expected 32-byte (64-character) slotHex, got "${slotHex}"`,
      { field: "slotHex" },
    );
  }
  return `0x${clean.toLowerCase()}`;
}

function isEmptyStorageValue(
  rawResponse: unknown,
): { isEmpty: true } | { isEmpty: false; cleanHex: string; rawBytes: Uint8Array } {
  if (rawResponse === null || rawResponse === undefined) {
    return { isEmpty: true };
  }
  if (typeof rawResponse !== "string") {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "kovanica_getStorageAt: expected hex string or null response",
    );
  }
  const trimmed = rawResponse.trim();
  if (trimmed.length === 0 || trimmed === "0x" || trimmed === "0X" || trimmed === "0x0" || trimmed === "0X0") {
    return { isEmpty: true };
  }
  const clean =
    trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  if (clean.length === 0) {
    return { isEmpty: true };
  }
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "kovanica_getStorageAt: invalid hex string in storage response",
    );
  }
  const rawBytes = hexToBytes(clean);
  if (rawBytes.length === 32 && rawBytes.every((b) => b === 0)) {
    return { isEmpty: true };
  }
  return {
    isEmpty: false,
    cleanHex: clean.toLowerCase(),
    rawBytes,
  };
}

/**
 * Reads a contract storage slot via `client.getStorageAt`, automatically deriving canonical or prefixed
 * BLAKE3 storage slots, detecting empty/zero storage slots, and optionally decoding Bincode state records.
 */
export async function readContractStorage<TDecoded>(
  client: ReadContractStorageClient,
  contract: Uint8Array | string,
  target: {
    slotHex: string;
    decoder: (bytes: Uint8Array) => TDecoded;
  },
  options?: ReadContractStorageOptions,
): Promise<ContractStorageReadResult<TDecoded>>;
export async function readContractStorage<K extends ContractLogKind>(
  client: ReadContractStorageClient,
  contract: Uint8Array | string,
  target: {
    slotHex: string;
    decoder: K;
  },
  options?: ReadContractStorageOptions,
): Promise<ContractStorageReadResult<DecodedContractLogByKind<K>["record"]>>;
export async function readContractStorage<TDecoded = undefined>(
  client: ReadContractStorageClient,
  contract: Uint8Array | string,
  target: {
    slotHex: string;
    decoder?: undefined;
  },
  options?: ReadContractStorageOptions,
): Promise<ContractStorageReadResult<TDecoded>>;
export async function readContractStorage<TDecoded>(
  client: ReadContractStorageClient,
  contract: Uint8Array | string,
  target: {
    kind: StorageSlotKind;
    key?: StorageSlotKey;
    decoder: (bytes: Uint8Array) => TDecoded;
  },
  options?: ReadContractStorageOptions,
): Promise<ContractStorageReadResult<TDecoded>>;
export async function readContractStorage<K extends ContractLogKind>(
  client: ReadContractStorageClient,
  contract: Uint8Array | string,
  target: {
    kind: StorageSlotKind;
    key?: StorageSlotKey;
    decoder: K;
  },
  options?: ReadContractStorageOptions,
): Promise<ContractStorageReadResult<DecodedContractLogByKind<K>["record"]>>;
export async function readContractStorage<S extends StorageSlotKind>(
  client: ReadContractStorageClient,
  contract: Uint8Array | string,
  target: {
    kind: S;
    key?: StorageSlotKey;
    decoder?: undefined;
  },
  options?: ReadContractStorageOptions,
): Promise<ContractStorageReadResult<DefaultDecodedStorageByKind<S>>>;
export async function readContractStorage<TDecoded>(
  client: ReadContractStorageClient,
  contract: Uint8Array | string,
  target: {
    prefix: string | Uint8Array;
    key?: string | Uint8Array;
    decoder: (bytes: Uint8Array) => TDecoded;
  },
  options?: ReadContractStorageOptions,
): Promise<ContractStorageReadResult<TDecoded>>;
export async function readContractStorage<K extends ContractLogKind>(
  client: ReadContractStorageClient,
  contract: Uint8Array | string,
  target: {
    prefix: string | Uint8Array;
    key?: string | Uint8Array;
    decoder: K;
  },
  options?: ReadContractStorageOptions,
): Promise<ContractStorageReadResult<DecodedContractLogByKind<K>["record"]>>;
export async function readContractStorage<TDecoded = undefined>(
  client: ReadContractStorageClient,
  contract: Uint8Array | string,
  target: {
    prefix: string | Uint8Array;
    key?: string | Uint8Array;
    decoder?: undefined;
  },
  options?: ReadContractStorageOptions,
): Promise<ContractStorageReadResult<TDecoded>>;
export async function readContractStorage<TDecoded = unknown>(
  client: ReadContractStorageClient,
  contract: Uint8Array | string,
  target: ContractStorageTarget<TDecoded>,
  options?: ReadContractStorageOptions,
): Promise<ContractStorageReadResult<TDecoded>>;
export async function readContractStorage<TDecoded = unknown>(
  client: ReadContractStorageClient,
  contract: Uint8Array | string,
  target: ContractStorageTarget<TDecoded>,
  options: ReadContractStorageOptions = {},
): Promise<ContractStorageReadResult<TDecoded>> {
  const contractBytes = parseContractAddress(contract);
  const canonicalContract = encodeAddress(contractBytes);

  if (!target || typeof target !== "object") {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "readContractStorage: target must be an object specifying slotHex, kind, or prefix",
      { field: "target" },
    );
  }

  let normalizedSlotHex: string;
  let effectiveDecoder: ContractLogKind | ((bytes: Uint8Array) => TDecoded) | undefined =
    target.decoder;

  if ("slotHex" in target && target.slotHex !== undefined) {
    normalizedSlotHex = normalizeAndValidateSlotHex(target.slotHex);
  } else if ("kind" in target && target.kind !== undefined) {
    const rawSlotHex = deriveStorageSlotHex(target.kind, target.key);
    normalizedSlotHex = `0x${rawSlotHex.toLowerCase()}`;
    if (effectiveDecoder === undefined) {
      effectiveDecoder = DEFAULT_DECODER_KIND_BY_SLOT_KIND[target.kind];
    }
  } else if ("prefix" in target && target.prefix !== undefined) {
    if (typeof target.prefix !== "string" && !(target.prefix instanceof Uint8Array)) {
      throw new KovanicaDecodeError(
        "INVALID_INPUT",
        "readContractStorage: prefix must be a string or Uint8Array",
        { field: "prefix" },
      );
    }
    if (
      target.key !== undefined &&
      typeof target.key !== "string" &&
      !(target.key instanceof Uint8Array)
    ) {
      throw new KovanicaDecodeError(
        "INVALID_INPUT",
        "readContractStorage: key for prefixed storage slot must be a string or Uint8Array",
        { field: "key" },
      );
    }
    const slotBytes = derivePrefixedStorageSlot(target.prefix, target.key);
    normalizedSlotHex = `0x${bytesToHex(slotBytes)}`;
  } else {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "readContractStorage: target must specify slotHex, kind, or prefix",
      { field: "target" },
    );
  }

  if (effectiveDecoder !== undefined && typeof effectiveDecoder !== "function") {
    if (
      typeof effectiveDecoder !== "string" ||
      !VALID_CONTRACT_LOG_KINDS.has(effectiveDecoder)
    ) {
      throw new KovanicaDecodeError(
        "INVALID_INPUT",
        `Unknown contract log kind: ${String(effectiveDecoder)}`,
        { field: "decoder" },
      );
    }
  }

  const rawStorage = await client.getStorageAt(
    canonicalContract,
    normalizedSlotHex,
    options.requestOptions,
  );

  const inspected = isEmptyStorageValue(rawStorage);
  if (inspected.isEmpty) {
    return {
      contract: canonicalContract,
      slotHex: normalizedSlotHex,
      rawHex: "0x",
      rawBytes: new Uint8Array(0),
      isEmpty: true,
    };
  }

  const rawHex = `0x${inspected.cleanHex}`;
  const { rawBytes } = inspected;

  if (effectiveDecoder !== undefined) {
    const decoded: TDecoded =
      typeof effectiveDecoder === "function"
        ? effectiveDecoder(rawBytes)
        : (decodeContractLog(rawBytes, effectiveDecoder).record as unknown as TDecoded);
    return {
      contract: canonicalContract,
      slotHex: normalizedSlotHex,
      rawHex,
      rawBytes,
      isEmpty: false,
      decoded,
    };
  }

  return {
    contract: canonicalContract,
    slotHex: normalizedSlotHex,
    rawHex,
    rawBytes,
    isEmpty: false,
  };
}
