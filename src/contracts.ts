/**
 * Canonical Smart Contract Argument Builders, Bincode Encoders & Transaction Signers
 * Verified against crates/kovanica-execution/src/call_args.rs (PR #302, #305) and kovanica-playground (PR #21).
 */

import { blake3 } from "@noble/hashes/blake3.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { decodeAddress, encodeAddress } from "./address";
import { CHAIN_IDS } from "./chains";
import { KovanicaDecodeError } from "./decoders";
import {
  KovanicaAbortError,
  KovanicaRpcError,
  KovanicaTimeoutError,
  RpcErrorCode,
} from "./errors";
import type { RequestOptions, TransactionReceipt } from "./types";
import { toHexQuantity } from "./units";

// --- Domain Tags & Gas Limits ---

export const DOMAIN_TAG_STR = "KVNC/tx/v1";
export const KEYED_HASH_TAG_STR = "KVNC-TX-v1";

export const DEFAULT_CALL_GAS_LIMIT = 100_000n;
export const MAX_TX_GAS_LIMIT = 10_000_000n;

/** Default fee safety margin in basis points (12_000 = 1.20x / +20%). */
export const DEFAULT_FEE_SAFETY_MARGIN_BPS = 12_000;
/** Default gas limit safety margin in basis points (12_000 = 1.20x / +20%). */
export const DEFAULT_GAS_SAFETY_MARGIN_BPS = 12_000;
/** Fixed wire byte overhead for a signed Call transaction outside `wireCallKindBytes`: 32 (sender) + 8 (nonce) + 8 (fee) + 8 (sig len) + 64 (sig) + 32 (sighash). */
export const CALL_TX_FIXED_WIRE_OVERHEAD = 152;

export function asciiPad(str: string, len: number): Uint8Array {
  const buf = new Uint8Array(len);
  for (let i = 0; i < str.length && i < len; i++) {
    buf[i] = str.charCodeAt(i);
  }
  return buf;
}

export const TX_DOMAIN = asciiPad(DOMAIN_TAG_STR, 16);
export const TX_KEY = asciiPad(KEYED_HASH_TAG_STR, 32);

// --- Little-Endian Numerical & Buffer Encoders ---

export function concatBytes(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, curr) => acc + curr.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${clean.length}`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const val = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(val)) {
      throw new Error(`Invalid byte '${clean.slice(i * 2, i * 2 + 2)}' in hex string`);
    }
    bytes[i] = val;
  }
  return bytes;
}

export function u32le(val: number | bigint): Uint8Array {
  const num = Number(val);
  if (!Number.isInteger(num) || num < 0 || num > 0xffffffff) {
    throw new RangeError(`Value out of range for u32: ${val}`);
  }
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, num, true);
  return buf;
}

export function u64le(val: number | bigint): Uint8Array {
  const b = BigInt(val);
  if (b < 0n || b > 0xffffffffffffffffn) {
    throw new RangeError(`Value out of range for u64: ${val}`);
  }
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, b, true);
  return buf;
}

export function u128le(val: number | bigint): Uint8Array {
  const b = BigInt(val);
  if (b < 0n || b > 0xffffffffffffffffffffffffffffffffn) {
    throw new RangeError(`Value out of range for u128: ${val}`);
  }
  const buf = new Uint8Array(16);
  const view = new DataView(buf.buffer);
  const low = b & 0xffffffffffffffffn;
  const high = b >> 64n;
  view.setBigUint64(0, low, true);
  view.setBigUint64(8, high, true);
  return buf;
}

// --- Deterministic Bincode Encoders ---

/**
 * Encodes a string in canonical Bincode format: 8-byte little-endian length prefix followed by UTF-8 bytes.
 */
export function encodeBincodeString(str: string): Uint8Array {
  const bytes = new TextEncoder().encode(str);
  return concatBytes([u64le(BigInt(bytes.length)), bytes]);
}

/**
 * Encodes a vector of 32-byte items in canonical Bincode format: 8-byte little-endian count prefix followed by 32-byte elements.
 */
export function encodeBincodeBytes32Vec(items: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [u64le(BigInt(items.length))];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.length !== 32) {
      throw new Error(`Expected 32-byte item, got ${item.length}`);
    }
    parts.push(item);
  }
  return concatBytes(parts);
}

/**
 * Encodes a vector of strings in canonical Bincode format: 8-byte little-endian count prefix followed by each Bincode-encoded string.
 */
export function encodeBincodeStringVec(items: string[]): Uint8Array {
  const parts: Uint8Array[] = [u64le(BigInt(items.length))];
  for (const s of items) {
    parts.push(encodeBincodeString(s));
  }
  return concatBytes(parts);
}

// --- Canonical Contract Call Payload Builders ---

/**
 * Encodes arguments for `name_register(name, pubkey, relay_endpoints)`.
 * Wire layout: `(String, [u8; 32], Vec<String>)`
 */
export function buildNameRegisterCall(
  name: string,
  pubkey: Uint8Array,
  relayEndpoints: string[],
): Uint8Array {
  if (pubkey.length !== 32) {
    throw new Error(`Expected 32-byte pubkey, got ${pubkey.length}`);
  }
  return concatBytes([
    encodeBincodeString(name),
    pubkey,
    encodeBincodeStringVec(relayEndpoints),
  ]);
}
export const encodeNameRegisterArgs = buildNameRegisterCall;

/**
 * Encodes arguments for `htlc_create(hashlock, timelock, recipient)`.
 * Wire layout: `([u8; 32], u64, [u8; 32])` (exact 72 bytes).
 */
export function buildHtlcCreateCall(
  hashlock: Uint8Array,
  timelock: bigint | number,
  recipient: Uint8Array,
): Uint8Array {
  if (hashlock.length !== 32) {
    throw new Error(`Expected 32-byte hashlock, got ${hashlock.length}`);
  }
  if (recipient.length !== 32) {
    throw new Error(`Expected 32-byte recipient, got ${recipient.length}`);
  }
  if (BigInt(timelock) < 0n) {
    throw new Error(`Timelock must be non-negative, got ${timelock}`);
  }
  return concatBytes([
    hashlock,
    u64le(timelock),
    recipient,
  ]);
}
export const encodeHtlcCreateArgs = buildHtlcCreateCall;

/**
 * Encodes arguments for `nft_mint(collection, to, token_id, token_uri)`.
 * Wire layout: `([u8; 32], [u8; 32], u128, String)` (88 bytes header + token_uri bytes).
 */
export function buildNftMintCall(
  collection: Uint8Array,
  to: Uint8Array,
  tokenId: bigint | number,
  tokenUri: string,
): Uint8Array {
  if (collection.length !== 32) {
    throw new Error(`Expected 32-byte collection, got ${collection.length}`);
  }
  if (to.length !== 32) {
    throw new Error(`Expected 32-byte to pubkey, got ${to.length}`);
  }
  if (BigInt(tokenId) < 0n) {
    throw new Error(`Token ID must be non-negative, got ${tokenId}`);
  }
  return concatBytes([
    collection,
    to,
    u128le(tokenId),
    encodeBincodeString(tokenUri),
  ]);
}
export const encodeNftMintArgs = buildNftMintCall;

/** Valid KVP-106 RWA asset classes. */
export const RWA_ASSET_CLASSES = ["RE", "BOND", "INVOICE", "COMMODITY", "FUND", "OTHER"] as const;
export type RwaAssetClass = (typeof RWA_ASSET_CLASSES)[number];

/**
 * Encodes arguments for `rwa_create(...)` (KVP-106).
 * Wire layout: `(String, String, String, String, u32, String, [u8; 32], String, String, String, u8, u128, u128)`.
 */
export function buildRwaCreateCall(params: {
  name: string;
  symbol: string;
  assetClass: RwaAssetClass;
  uniqueId: string;
  version: number;
  jurisdiction?: string;
  metadataHash: Uint8Array;
  metadataUri?: string;
  legalUri?: string;
  custodyUri?: string;
  decimals: number;
  maxSupply: bigint | number;
  initialSupply: bigint | number;
}): Uint8Array {
  if (!RWA_ASSET_CLASSES.includes(params.assetClass)) {
    throw new Error(`Invalid RWA asset class: ${params.assetClass}`);
  }
  if (params.metadataHash.length !== 32) {
    throw new Error(`Expected 32-byte metadataHash, got ${params.metadataHash.length}`);
  }
  if (!Number.isInteger(params.version) || params.version < 1) {
    throw new Error(`Version must be a positive integer, got ${params.version}`);
  }
  if (!Number.isInteger(params.decimals) || params.decimals < 0 || params.decimals > 18) {
    throw new Error(`Decimals must be between 0 and 18, got ${params.decimals}`);
  }
  return concatBytes([
    encodeBincodeString(params.name),
    encodeBincodeString(params.symbol),
    encodeBincodeString(params.assetClass),
    encodeBincodeString(params.uniqueId),
    u32le(params.version),
    encodeBincodeString(params.jurisdiction ?? ""),
    params.metadataHash,
    encodeBincodeString(params.metadataUri ?? ""),
    encodeBincodeString(params.legalUri ?? ""),
    encodeBincodeString(params.custodyUri ?? ""),
    Uint8Array.of(params.decimals),
    u128le(params.maxSupply),
    u128le(params.initialSupply),
  ]);
}
export const encodeRwaCreateArgs = buildRwaCreateCall;

/** Encodes arguments for `rwa_mint(to, amount)`. Wire layout: `([u8; 32], u128)`. */
export function buildRwaMintCall(to: Uint8Array, amount: bigint | number): Uint8Array {
  if (to.length !== 32) {
    throw new Error(`Expected 32-byte to address, got ${to.length}`);
  }
  if (BigInt(amount) <= 0n) {
    throw new Error(`Amount must be positive, got ${amount}`);
  }
  return concatBytes([to, u128le(amount)]);
}
export const encodeRwaMintArgs = buildRwaMintCall;

/** Encodes arguments for `rwa_transfer(to, amount)`. Wire layout: `([u8; 32], u128)`. */
export function buildRwaTransferCall(to: Uint8Array, amount: bigint | number): Uint8Array {
  if (to.length !== 32) {
    throw new Error(`Expected 32-byte to address, got ${to.length}`);
  }
  if (BigInt(amount) <= 0n) {
    throw new Error(`Amount must be positive, got ${amount}`);
  }
  return concatBytes([to, u128le(amount)]);
}
export const encodeRwaTransferArgs = buildRwaTransferCall;

/** Encodes arguments for `rwa_burn(amount)`. Wire layout: `u128`. */
export function buildRwaBurnCall(amount: bigint | number): Uint8Array {
  if (BigInt(amount) <= 0n) {
    throw new Error(`Amount must be positive, got ${amount}`);
  }
  return u128le(amount);
}
export const encodeRwaBurnArgs = buildRwaBurnCall;

/** Encodes arguments for `rwa_freeze(account, frozen)`. Wire layout: `([u8; 32], bool)`. */
export function buildRwaFreezeCall(account: Uint8Array, frozen: boolean): Uint8Array {
  if (account.length !== 32) {
    throw new Error(`Expected 32-byte account address, got ${account.length}`);
  }
  return concatBytes([account, Uint8Array.of(frozen ? 1 : 0)]);
}
export const encodeRwaFreezeArgs = buildRwaFreezeCall;

/** Encodes arguments for `rwa_update_metadata(metadata_hash, metadata_uri, legal_uri, custody_uri)`. */
export function buildRwaUpdateMetadataCall(params: {
  metadataHash: Uint8Array;
  metadataUri?: string;
  legalUri?: string;
  custodyUri?: string;
}): Uint8Array {
  if (params.metadataHash.length !== 32) {
    throw new Error(`Expected 32-byte metadataHash, got ${params.metadataHash.length}`);
  }
  return concatBytes([
    params.metadataHash,
    encodeBincodeString(params.metadataUri ?? ""),
    encodeBincodeString(params.legalUri ?? ""),
    encodeBincodeString(params.custodyUri ?? ""),
  ]);
}
export const encodeRwaUpdateMetadataArgs = buildRwaUpdateMetadataCall;

/**
 * Encodes arguments for `escrow_create(parties, threshold, amount, deadline)`.
 * Wire layout: `(Vec<[u8; 32]>, u8, u64, u64)`.
 */
export function buildEscrowCreateCall(
  parties: Uint8Array[],
  threshold: number,
  amount: bigint | number,
  deadline: bigint | number,
): Uint8Array {
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) {
    throw new Error(`Threshold must be between 0 and 255, got ${threshold}`);
  }
  if (threshold < 1) {
    throw new Error(`Threshold must be at least 1, got ${threshold}`);
  }
  if (threshold > parties.length) {
    throw new Error(`Threshold cannot exceed number of parties (${parties.length}), got ${threshold}`);
  }
  if (BigInt(amount) < 0n) {
    throw new Error(`Amount must be non-negative, got ${amount}`);
  }
  if (BigInt(deadline) < 0n) {
    throw new Error(`Deadline must be non-negative, got ${deadline}`);
  }
  return concatBytes([
    encodeBincodeBytes32Vec(parties),
    Uint8Array.of(threshold),
    u64le(amount),
    u64le(deadline),
  ]);
}
export const encodeEscrowCreateArgs = buildEscrowCreateCall;

// --- Call Transaction Builders ---

export interface CallTxKind {
  type: "call";
  contract: Uint8Array;
  method: string;
  args: Uint8Array;
  call_value: bigint;
  gas_limit: bigint;
  // Aliases for developer convenience
  value: bigint;
  gasLimit: bigint;
}

export interface CallTxKindInput {
  contract: Uint8Array | string;
  method: string;
  args: Uint8Array;
  call_value?: bigint | number;
  value?: bigint | number;
  gas_limit?: bigint | number;
  gasLimit?: bigint | number;
}

export function parseContractAddress(contract: Uint8Array | string): Uint8Array {
  if (contract instanceof Uint8Array) {
    if (contract.length !== 32) {
      throw new Error(`Expected 32-byte contract address, got ${contract.length}`);
    }
    return contract;
  }
  const trimmed = contract.trim();
  if (trimmed.startsWith("kvnc") || trimmed.startsWith("tknc")) {
    return decodeAddress(trimmed);
  }
  const bytes = hexToBytes(trimmed);
  if (bytes.length !== 32) {
    throw new Error(`Expected 32-byte contract address, got ${bytes.length}`);
  }
  return bytes;
}

export function buildCallTxKind(input: CallTxKindInput): CallTxKind {
  const contract = parseContractAddress(input.contract);
  const val = BigInt(input.call_value ?? input.value ?? 0n);
  if (val < 0n) {
    throw new Error(`call_value must be non-negative, got ${val}`);
  }
  const gas = BigInt(input.gas_limit ?? input.gasLimit ?? DEFAULT_CALL_GAS_LIMIT);
  if (gas < 0n) {
    throw new Error(`gas_limit must be non-negative, got ${gas}`);
  }
  if (gas > MAX_TX_GAS_LIMIT) {
    throw new Error(`gas_limit ${gas} exceeds maximum allowed ${MAX_TX_GAS_LIMIT}`);
  }

  return {
    type: "call",
    contract,
    method: input.method,
    args: input.args,
    call_value: val,
    value: val,
    gas_limit: gas,
    gasLimit: gas,
  };
}

export function buildNameRegisterCallTx(
  contractPubkey: Uint8Array | string,
  name: string,
  pubkey: Uint8Array,
  relayEndpoints: string[],
  gasLimit: bigint | number = DEFAULT_CALL_GAS_LIMIT,
): CallTxKind {
  return buildCallTxKind({
    contract: contractPubkey,
    method: "name_register",
    args: buildNameRegisterCall(name, pubkey, relayEndpoints),
    gas_limit: gasLimit,
  });
}

export function buildHtlcCreateCallTx(
  contractPubkey: Uint8Array | string,
  hashlock: Uint8Array,
  timelock: bigint | number,
  recipient: Uint8Array,
  gasLimit: bigint | number = DEFAULT_CALL_GAS_LIMIT,
): CallTxKind {
  return buildCallTxKind({
    contract: contractPubkey,
    method: "htlc_create",
    args: buildHtlcCreateCall(hashlock, timelock, recipient),
    gas_limit: gasLimit,
  });
}

export function buildNftMintCallTx(
  contractPubkey: Uint8Array | string,
  collection: Uint8Array,
  to: Uint8Array,
  tokenId: bigint | number,
  tokenUri: string,
  gasLimit: bigint | number = DEFAULT_CALL_GAS_LIMIT,
): CallTxKind {
  return buildCallTxKind({
    contract: contractPubkey,
    method: "nft_mint",
    args: buildNftMintCall(collection, to, tokenId, tokenUri),
    gas_limit: gasLimit,
  });
}

export function buildEscrowCreateCallTx(
  contractPubkey: Uint8Array | string,
  parties: Uint8Array[],
  threshold: number,
  amount: bigint | number,
  deadline: bigint | number,
  gasLimit: bigint | number = DEFAULT_CALL_GAS_LIMIT,
): CallTxKind {
  return buildCallTxKind({
    contract: contractPubkey,
    method: "escrow_create",
    args: buildEscrowCreateCall(parties, threshold, amount, deadline),
    gas_limit: gasLimit,
  });
}

export function buildTokenTransferCall(
  contractPubkey: Uint8Array | string,
  recipientPubkey: Uint8Array,
  tokenUnits: bigint | number,
  gasLimit: bigint | number = DEFAULT_CALL_GAS_LIMIT,
): CallTxKind {
  if (recipientPubkey.length !== 32) {
    throw new Error(`Expected 32-byte recipient pubkey, got ${recipientPubkey.length}`);
  }
  return buildCallTxKind({
    contract: contractPubkey,
    method: "token_transfer",
    args: concatBytes([recipientPubkey, u128le(tokenUnits)]),
    gas_limit: gasLimit,
  });
}

export function buildVaultCreateCall(
  contractPubkey: Uint8Array | string,
  beneficiaryPubkey: Uint8Array,
  amountAtoms: bigint | number,
  lockUntilMs: bigint | number,
  gasLimit: bigint | number = DEFAULT_CALL_GAS_LIMIT,
): CallTxKind {
  if (beneficiaryPubkey.length !== 32) {
    throw new Error(`Expected 32-byte beneficiary pubkey, got ${beneficiaryPubkey.length}`);
  }
  return buildCallTxKind({
    contract: contractPubkey,
    method: "vault_create",
    args: concatBytes([
      beneficiaryPubkey,
      u128le(amountAtoms),
      u32le(0),
      u64le(lockUntilMs),
    ]),
    gas_limit: gasLimit,
  });
}

// --- Transaction Signing & Bincode Serialization ---

export interface SignedTxResult {
  sighash: Uint8Array;
  sighashHex: string;
  signature: Uint8Array;
  signatureHex: string;
  rawTxBytes: Uint8Array;
  rawTxHex: string;
  txSize: number;
}

export function signingCallKindBytes(call: CallTxKind): Uint8Array {
  const methodBytes = new TextEncoder().encode(call.method);
  return concatBytes([
    Uint8Array.of(4), // TransactionKind::Call tag in signing preimage
    call.contract,
    u64le(call.call_value),
    u64le(BigInt(methodBytes.length)),
    methodBytes,
    u64le(BigInt(call.args.length)),
    call.args,
    u64le(call.gas_limit),
  ]);
}

export function wireCallKindBytes(call: CallTxKind): Uint8Array {
  const methodBytes = new TextEncoder().encode(call.method);
  return concatBytes([
    u32le(6), // TransactionKind::Call enum variant index in bincode
    call.contract,
    u64le(call.call_value),
    u64le(BigInt(methodBytes.length)),
    methodBytes,
    u64le(BigInt(call.args.length)),
    call.args,
    u64le(call.gas_limit),
  ]);
}

/**
 * Computes the domain-tagged BLAKE3 signing hash for a Call transaction.
 */
export function computeCallTransactionSigningHash(
  tx: {
    sender: Uint8Array;
    nonce: bigint | number;
    call: CallTxKind;
    fee: bigint | number;
  },
  chainId: number = CHAIN_IDS.MAINNET,
): Uint8Array {
  const preimage = concatBytes([
    TX_DOMAIN,
    u64le(BigInt(chainId)),
    tx.sender,
    u64le(tx.nonce),
    signingCallKindBytes(tx.call),
    u64le(tx.fee),
  ]);
  return blake3(preimage, { key: TX_KEY });
}

// --- Pure JS Ed25519 Signing Implementation ---

const ED_P = 2n ** 255n - 19n;
const ED_L = (1n << 252n) + 27742317777372353535851937790883648493n;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let res = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) res = (res * base) % mod;
    base = (base * base) % mod;
    exp /= 2n;
  }
  return res;
}

function modInverse(n: bigint, m: bigint): bigint {
  return modPow(n, m - 2n, m);
}

const ed_d = (-121665n * modInverse(121666n, ED_P)) % ED_P;
const ed_d_mod = (ed_d + ED_P) % ED_P;
const ed_I = modPow(2n, (ED_P - 1n) / 4n, ED_P);

function recoverX(y: bigint): bigint {
  const y2 = (y * y) % ED_P;
  const u = (y2 - 1n + ED_P) % ED_P;
  const v = (ed_d_mod * y2 + 1n) % ED_P;
  let x = (u * modInverse(v, ED_P)) % ED_P;
  x = modPow(x, (ED_P + 3n) / 8n, ED_P);
  if ((x * x - u * modInverse(v, ED_P)) % ED_P !== 0n) {
    x = (x * ed_I) % ED_P;
  }
  if (x % 2n !== 0n) x = ED_P - x;
  return x;
}

const ed_By = (4n * modInverse(5n, ED_P)) % ED_P;
const ed_Bx = recoverX(ed_By);
type ExtendedPoint = [bigint, bigint, bigint, bigint];
const ed_B: ExtendedPoint = [ed_Bx, ed_By, 1n, (ed_Bx * ed_By) % ED_P];

function pointAdd(p1: ExtendedPoint, p2: ExtendedPoint): ExtendedPoint {
  const [X1, Y1, Z1, T1] = p1;
  const [X2, Y2, Z2, T2] = p2;
  const A = ((Y1 - X1 + ED_P) * (Y2 - X2 + ED_P)) % ED_P;
  const B_coord = ((Y1 + X1) * (Y2 + X2)) % ED_P;
  const C = (2n * T1 * T2 * ed_d_mod) % ED_P;
  const D = (2n * Z1 * Z2) % ED_P;
  const E = (B_coord - A + ED_P) % ED_P;
  const F = (D - C + ED_P) % ED_P;
  const G = (D + C) % ED_P;
  const H = (B_coord + A) % ED_P;
  return [(E * F) % ED_P, (G * H) % ED_P, (F * G) % ED_P, (E * H) % ED_P];
}

function pointDouble(p: ExtendedPoint): ExtendedPoint {
  const [X1, Y1, Z1] = p;
  const A = (X1 * X1) % ED_P;
  const B_coord = (Y1 * Y1) % ED_P;
  const C = (2n * Z1 * Z1) % ED_P;
  const D = (ED_P - A) % ED_P;
  const E = ((X1 + Y1) * (X1 + Y1) - A - B_coord + 2n * ED_P) % ED_P;
  const G = (D + B_coord) % ED_P;
  const F = (G - C + ED_P) % ED_P;
  const H = (D - B_coord + ED_P) % ED_P;
  return [(E * F) % ED_P, (G * H) % ED_P, (F * G) % ED_P, (E * H) % ED_P];
}

function scalarMult(k: bigint, pt: ExtendedPoint): ExtendedPoint {
  let r: ExtendedPoint = [0n, 1n, 1n, 0n];
  let base = pt;
  let tempK = k;
  while (tempK > 0n) {
    if (tempK & 1n) r = pointAdd(r, base);
    base = pointDouble(base);
    tempK >>= 1n;
  }
  return r;
}

function pointToBytes(pt: ExtendedPoint): Uint8Array {
  const [X, Y, Z] = pt;
  const zInv = modInverse(Z, ED_P);
  const x = (X * zInv) % ED_P;
  const y = (Y * zInv) % ED_P;
  const pub = new Uint8Array(32);
  let tempY = y;
  for (let i = 0; i < 32; i++) {
    pub[i] = Number(tempY & 0xffn);
    tempY >>= 8n;
  }
  if (x & 1n) {
    pub[31]! |= 0x80;
  }
  return pub;
}

function bytesToBigintLE(bytes: Uint8Array): bigint {
  let res = 0n;
  for (let i = 0; i < bytes.length; i++) {
    res |= BigInt(bytes[i]!) << BigInt(8 * i);
  }
  return res;
}

function bigintToBytesLE(num: bigint, len = 32): Uint8Array {
  const out = new Uint8Array(len);
  let temp = num;
  for (let i = 0; i < len; i++) {
    out[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }
  return out;
}

/**
 * Pure TypeScript Ed25519 signature computation adhering to RFC 8032.
 */
export function signEd25519(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== 32) {
    throw new Error(`Secret key must be 32 bytes, got ${secretKey.length}`);
  }
  const hash = sha512(secretKey);
  const clamped = new Uint8Array(hash.slice(0, 32));
  clamped[0] &= 248;
  clamped[31] &= 127;
  clamped[31] |= 64;

  const a = bytesToBigintLE(clamped);
  const A = pointToBytes(scalarMult(a, ed_B));
  const prefix = hash.slice(32, 64);

  const rHash = sha512(concatBytes([prefix, message]));
  const r = bytesToBigintLE(rHash) % ED_L;
  const R = pointToBytes(scalarMult(r, ed_B));

  const kHash = sha512(concatBytes([R, A, message]));
  const k = bytesToBigintLE(kHash) % ED_L;
  const s = (r + k * a) % ED_L;

  clamped.fill(0);
  return concatBytes([R, bigintToBytesLE(s, 32)]);
}

/**
 * Constructs and signs a Call contract transaction.
 */
export function signCallContractTransaction(params: {
  sender: Uint8Array | string;
  secretKey: Uint8Array;
  call: CallTxKind | CallTxKindInput;
  nonce: bigint | number;
  fee: bigint | number;
  chainId?: number;
}): SignedTxResult {
  const senderBytes =
    params.sender instanceof Uint8Array
      ? params.sender
      : parseContractAddress(params.sender);

  if (senderBytes.length !== 32) {
    throw new Error(`Sender must be 32 bytes, got ${senderBytes.length}`);
  }
  if (params.secretKey.length !== 32) {
    throw new Error(`Secret key must be 32 bytes, got ${params.secretKey.length}`);
  }

  const callKind = "call_value" in params.call && "gas_limit" in params.call
    ? (params.call as CallTxKind)
    : buildCallTxKind(params.call);

  const chainId = params.chainId ?? CHAIN_IDS.MAINNET;
  const sighash = computeCallTransactionSigningHash(
    {
      sender: senderBytes,
      nonce: params.nonce,
      call: callKind,
      fee: params.fee,
    },
    chainId,
  );

  const signature = signEd25519(sighash, params.secretKey);

  const rawTxBytes = concatBytes([
    senderBytes,
    u64le(params.nonce),
    wireCallKindBytes(callKind),
    u64le(params.fee),
    u64le(64n), // u64 LE length prefix for Signature in bincode
    signature,
    sighash,
  ]);

  return {
    sighash,
    sighashHex: bytesToHex(sighash),
    signature,
    signatureHex: bytesToHex(signature),
    rawTxBytes,
    rawTxHex: bytesToHex(rawTxBytes),
    txSize: rawTxBytes.length,
  };
}

// --- Fee/Gas Estimation & Prepared Call Builder ---

/**
 * Minimal client interface required by {@link estimateAndBuildCall}.
 * Satisfied by {@link KovanicaClient}.
 */
export interface EstimateAndBuildCallClient {
  estimateFee(options?: RequestOptions): Promise<bigint>;
  getNonce(address: string, options?: RequestOptions): Promise<bigint>;
}

export interface EstimateAndBuildCallOptions {
  /**
   * Optional sender address (PRO-21 `kvnc...dag` / `tknc...dag` or 32-byte hex).
   * When provided and `nonce` is omitted, fetches the sender's current nonce via `client.getNonce(sender)`.
   */
  sender?: string;
  /**
   * Explicit nonce override. Skips the `client.getNonce` RPC call when provided.
   */
  nonce?: bigint | number;
  /**
   * Explicit total fee override in atoms. Skips the `client.estimateFee` RPC call when provided.
   */
  fee?: bigint | number;
  /**
   * Fee safety margin in basis points (`10_000` = 1.0x, `12_000` = +20%).
   * Applied to `feeRatePerByte * estimatedTxSize` when `fee` is not explicitly overridden.
   * Default: {@link DEFAULT_FEE_SAFETY_MARGIN_BPS} (`12_000`).
   */
  feeMarginBps?: number;
  /**
   * Gas limit safety margin in basis points (`10_000` = 1.0x, `12_000` = +20%).
   * Applied to the call's gas limit (clamped to {@link MAX_TX_GAS_LIMIT}) when `gasLimit` / `gas_limit`
   * is not explicitly supplied on `call`, or whenever `gasMarginBps` is explicitly specified.
   * Default: {@link DEFAULT_GAS_SAFETY_MARGIN_BPS} (`12_000`) for defaulted gas, or `10_000` (1.0x) when explicit gas was provided.
   */
  gasMarginBps?: number;
  /**
   * Minimum fee floor in atoms. Default: `0n`.
   */
  minFee?: bigint | number;
  /**
   * Optional maximum fee cap in atoms. Throws if the computed or overridden fee exceeds this cap.
   */
  maxFee?: bigint | number;
  /**
   * Chain ID to attach to the prepared call transaction. Default: `CHAIN_IDS.MAINNET`.
   */
  chainId?: number;
  /**
   * Optional RPC request options (`timeoutMs`, `signal`) forwarded to `estimateFee` and `getNonce`.
   */
  requestOptions?: RequestOptions;
}

export interface PreparedCallTransaction {
  /** Validated `CallTxKind` with resolved gas limit, ready for `signCallContractTransaction` or `wallet.signCallTransaction`. */
  call: CallTxKind;
  /** Estimated or overridden total transaction fee in atoms (includes safety margin and `minFee` floor). */
  fee: bigint;
  /** Raw fee rate returned by `kovanica_estimateFee` in atoms per byte (`undefined` when `fee` was explicitly overridden). */
  feeRatePerByte?: bigint;
  /** Exact serialized wire size of the signed Call transaction in bytes. */
  estimatedTxSize: number;
  /** Resolved gas limit applied to `call.gas_limit` and `call.gasLimit`. */
  gasLimit: bigint;
  /** Resolved sender nonce (fetched via `client.getNonce` when `sender` is provided, or explicit override; `undefined` if neither was supplied). */
  nonce?: bigint;
  /** Chain ID attached for signing. */
  chainId: number;
}

const BPS_DENOMINATOR = 10_000n;

function validateMarginBps(value: number, name: string): bigint {
  if (!Number.isInteger(value) || value < 10_000) {
    throw new RangeError(`${name} must be an integer >= 10000 (1.0x), got ${value}`);
  }
  return BigInt(value);
}

function applyBpsCeil(amount: bigint, marginBps: bigint): bigint {
  if (amount === 0n) return 0n;
  return (amount * marginBps + (BPS_DENOMINATOR - 1n)) / BPS_DENOMINATOR;
}

/**
 * Computes the exact serialized wire byte size of a signed Call transaction.
 * Matches `signCallContractTransaction(...).txSize` byte-for-byte.
 */
export function estimateCallTxSize(call: CallTxKind | CallTxKindInput): number {
  const callKind =
    "call_value" in call && "gas_limit" in call && call.contract instanceof Uint8Array
      ? (call as CallTxKind)
      : buildCallTxKind(call);
  return CALL_TX_FIXED_WIRE_OVERHEAD + wireCallKindBytes(callKind).length;
}

/**
 * Estimates fee/gas parameters for a contract call and builds a validated,
 * ready-to-sign {@link PreparedCallTransaction} payload with configurable safety margins.
 *
 * - Validates and normalizes `call` (applying `gasMarginBps` when gas is defaulted or explicitly requested, clamped to {@link MAX_TX_GAS_LIMIT}).
 * - Computes exact wire transaction size via {@link estimateCallTxSize}.
 * - Fetches `kovanica_estimateFee` (unless `options.fee` is provided) and `kovanica_getNonce` (when `options.sender` is provided and `options.nonce` is omitted) in parallel.
 * - Applies `feeMarginBps` (default 12_000 = +20%) and enforces `minFee` floor / `maxFee` cap.
 */
export async function estimateAndBuildCall(
  client: EstimateAndBuildCallClient,
  call: CallTxKind | CallTxKindInput,
  options: EstimateAndBuildCallOptions = {},
): Promise<PreparedCallTransaction> {
  const feeMarginBps = validateMarginBps(
    options.feeMarginBps ?? DEFAULT_FEE_SAFETY_MARGIN_BPS,
    "feeMarginBps",
  );

  const hasExplicitGas = call.gas_limit !== undefined || call.gasLimit !== undefined;
  const gasMarginBps =
    options.gasMarginBps !== undefined
      ? validateMarginBps(options.gasMarginBps, "gasMarginBps")
      : hasExplicitGas
        ? BPS_DENOMINATOR
        : BigInt(DEFAULT_GAS_SAFETY_MARGIN_BPS);

  const minFee = options.minFee !== undefined ? BigInt(options.minFee) : 0n;
  if (minFee < 0n) {
    throw new RangeError(`minFee must be non-negative, got ${minFee}`);
  }

  const maxFee = options.maxFee !== undefined ? BigInt(options.maxFee) : undefined;
  if (maxFee !== undefined && maxFee < 0n) {
    throw new RangeError(`maxFee must be non-negative, got ${maxFee}`);
  }
  if (maxFee !== undefined && minFee > maxFee) {
    throw new RangeError(`minFee (${minFee}) cannot exceed maxFee (${maxFee})`);
  }

  let explicitNonce: bigint | undefined;
  if (options.nonce !== undefined) {
    explicitNonce = BigInt(options.nonce);
    if (explicitNonce < 0n) {
      throw new RangeError(`nonce must be non-negative, got ${explicitNonce}`);
    }
  }

  let explicitFee: bigint | undefined;
  if (options.fee !== undefined) {
    explicitFee = BigInt(options.fee);
    if (explicitFee < 0n) {
      throw new RangeError(`fee must be non-negative, got ${explicitFee}`);
    }
  }

  // Validate and build the base call first so invalid inputs fail before any RPC I/O.
  const baseCall = buildCallTxKind(call);
  const marginedGas = applyBpsCeil(baseCall.gas_limit, gasMarginBps);
  const resolvedGasLimit = marginedGas > MAX_TX_GAS_LIMIT ? MAX_TX_GAS_LIMIT : marginedGas;

  const preparedCall: CallTxKind =
    resolvedGasLimit === baseCall.gas_limit
      ? baseCall
      : {
          ...baseCall,
          gas_limit: resolvedGasLimit,
          gasLimit: resolvedGasLimit,
        };

  const estimatedTxSize = estimateCallTxSize(preparedCall);

  const needsFeeEstimate = explicitFee === undefined;
  const needsNonce = explicitNonce === undefined && options.sender !== undefined;

  const [feeRatePerByte, fetchedNonce] = await Promise.all([
    needsFeeEstimate ? client.estimateFee(options.requestOptions) : Promise.resolve(undefined),
    needsNonce
      ? client.getNonce(options.sender!, options.requestOptions)
      : Promise.resolve(undefined),
  ]);

  let fee: bigint;
  if (explicitFee !== undefined) {
    fee = explicitFee;
  } else {
    if (feeRatePerByte! < 0n) {
      throw new RangeError(`Estimated fee rate must be non-negative, got ${feeRatePerByte}`);
    }
    const baseFee = feeRatePerByte! * BigInt(estimatedTxSize);
    const marginedFee = applyBpsCeil(baseFee, feeMarginBps);
    fee = marginedFee < minFee ? minFee : marginedFee;
  }

  if (maxFee !== undefined && fee > maxFee) {
    throw new RangeError(`Computed fee ${fee} exceeds maxFee ${maxFee}`);
  }

  return {
    call: preparedCall,
    fee,
    feeRatePerByte,
    estimatedTxSize,
    gasLimit: resolvedGasLimit,
    nonce: explicitNonce ?? fetchedNonce,
    chainId: options.chainId ?? CHAIN_IDS.MAINNET,
  };
}

// --- Multi-Call Batch Estimator (`estimateBatchCalls`) ---

export interface EstimateBatchCallsOptions {
  /**
   * Optional sender address (PRO-21 `kvnc...dag` / `tknc...dag` or 32-byte hex).
   * When provided and `startNonce` is omitted, fetches the sender's current nonce once via `client.getNonce(sender)`.
   */
  sender?: string;
  /**
   * Explicit starting nonce override for the first call in the batch (`calls[0]`).
   * Subsequent calls receive sequential nonces `startNonce + BigInt(i)`.
   * Skips the `client.getNonce` RPC call when provided.
   */
  startNonce?: bigint | number;
  /**
   * Explicit fee rate override in atoms per byte. Skips the `client.estimateFee` RPC call when provided.
   */
  feeRatePerByte?: bigint | number;
  /**
   * Fee safety margin in basis points (`10_000` = 1.0x, `12_000` = +20%).
   * Applied to `feeRatePerByte * estimatedTxSize` for each call in the batch.
   * Default: {@link DEFAULT_FEE_SAFETY_MARGIN_BPS} (`12_000`).
   */
  feeMarginBps?: number;
  /**
   * Gas limit safety margin in basis points (`10_000` = 1.0x, `12_000` = +20%).
   * Applied to each call's gas limit (clamped to {@link MAX_TX_GAS_LIMIT}) when `gasLimit` / `gas_limit`
   * is not explicitly supplied on that call, or whenever `gasMarginBps` is explicitly specified.
   * Default: {@link DEFAULT_GAS_SAFETY_MARGIN_BPS} (`12_000`) for defaulted gas, or `10_000` (1.0x) when explicit gas was provided.
   */
  gasMarginBps?: number;
  /**
   * Minimum fee floor per individual call in atoms. Default: `0n`.
   */
  minFeePerCall?: bigint | number;
  /**
   * Optional maximum aggregate fee cap across the entire batch in atoms.
   * Throws a `RangeError` if the sum of all calls' fees exceeds this cap.
   */
  maxTotalFee?: bigint | number;
  /**
   * Chain ID to attach to each prepared call transaction and the batch result. Default: `CHAIN_IDS.MAINNET`.
   */
  chainId?: number;
  /**
   * Optional RPC request options (`timeoutMs`, `signal`) forwarded to `estimateFee` and `getNonce`.
   */
  requestOptions?: RequestOptions;
}

export interface PreparedBatchCallTransactions {
  /** Prepared call transactions in input order, with sequential nonces when `sender` or `startNonce` is provided. */
  calls: PreparedCallTransaction[];
  /** Sum of `fee` across all calls in the batch (in atoms). */
  totalFee: bigint;
  /** Sum of `gasLimit` across all calls in the batch. */
  totalGasLimit: bigint;
  /** Sum of `estimatedTxSize` across all calls in the batch (in bytes). */
  totalEstimatedTxSize: number;
  /** Fee rate in atoms per byte used to estimate the batch. */
  feeRatePerByte: bigint;
  /** Resolved starting nonce assigned to `calls[0]` (`undefined` when neither `sender` nor `startNonce` was provided). */
  startNonce?: bigint;
  /** Chain ID attached to each call in the batch. */
  chainId: number;
}

/**
 * Estimates fee/gas parameters for a non-empty batch of contract calls in a single parallel RPC round-trip
 * (`kovanica_estimateFee` + `kovanica_getNonce`) and returns sequential-nonce {@link PreparedCallTransaction} items
 * along with batch totals ({@link PreparedBatchCallTransactions}).
 *
 * - Validates options and every call in `calls` fail-closed before any RPC I/O.
 * - Fetches `kovanica_estimateFee` once (unless `options.feeRatePerByte` is provided) and `kovanica_getNonce(sender)`
 *   once (when `options.sender` is provided and `options.startNonce` is omitted) in parallel.
 * - Assigns sequential nonces `startNonce + BigInt(i)` when `startNonce` or `sender` is provided.
 * - Enforces `minFeePerCall` on each call and optional `maxTotalFee` across the entire batch.
 */
export async function estimateBatchCalls(
  client: EstimateAndBuildCallClient,
  calls: ReadonlyArray<CallTxKind | CallTxKindInput>,
  options: EstimateBatchCallsOptions = {},
): Promise<PreparedBatchCallTransactions> {
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new RangeError("estimateBatchCalls requires a non-empty array of calls");
  }

  const feeMarginBps = validateMarginBps(
    options.feeMarginBps ?? DEFAULT_FEE_SAFETY_MARGIN_BPS,
    "feeMarginBps",
  );

  const explicitGasMarginBps =
    options.gasMarginBps !== undefined
      ? validateMarginBps(options.gasMarginBps, "gasMarginBps")
      : undefined;

  const minFeePerCall =
    options.minFeePerCall !== undefined ? BigInt(options.minFeePerCall) : 0n;
  if (minFeePerCall < 0n) {
    throw new RangeError(`minFeePerCall must be non-negative, got ${minFeePerCall}`);
  }

  const maxTotalFee =
    options.maxTotalFee !== undefined ? BigInt(options.maxTotalFee) : undefined;
  if (maxTotalFee !== undefined && maxTotalFee < 0n) {
    throw new RangeError(`maxTotalFee must be non-negative, got ${maxTotalFee}`);
  }

  const minPossibleTotalFee = minFeePerCall * BigInt(calls.length);
  if (maxTotalFee !== undefined && minPossibleTotalFee > maxTotalFee) {
    throw new RangeError(
      `minFeePerCall * calls.length (${minPossibleTotalFee}) cannot exceed maxTotalFee (${maxTotalFee})`,
    );
  }

  let explicitStartNonce: bigint | undefined;
  if (options.startNonce !== undefined) {
    explicitStartNonce = BigInt(options.startNonce);
    if (explicitStartNonce < 0n) {
      throw new RangeError(`startNonce must be non-negative, got ${explicitStartNonce}`);
    }
  }

  let explicitFeeRate: bigint | undefined;
  if (options.feeRatePerByte !== undefined) {
    explicitFeeRate = BigInt(options.feeRatePerByte);
    if (explicitFeeRate < 0n) {
      throw new RangeError(
        `feeRatePerByte must be non-negative, got ${explicitFeeRate}`,
      );
    }
  }

  // Validate and normalize all calls fail-closed before performing any RPC I/O.
  const prebuiltCalls: Array<{
    preparedCall: CallTxKind;
    resolvedGasLimit: bigint;
    estimatedTxSize: number;
  }> = [];

  for (let i = 0; i < calls.length; i++) {
    const inputCall = calls[i]!;
    if (!inputCall || typeof inputCall !== "object") {
      throw new TypeError(`Call at index ${i} must be a valid call object`);
    }
    const hasExplicitGas =
      inputCall.gas_limit !== undefined || inputCall.gasLimit !== undefined;
    const gasMarginBps =
      explicitGasMarginBps ??
      (hasExplicitGas ? BPS_DENOMINATOR : BigInt(DEFAULT_GAS_SAFETY_MARGIN_BPS));

    const baseCall = buildCallTxKind(inputCall);
    const marginedGas = applyBpsCeil(baseCall.gas_limit, gasMarginBps);
    const resolvedGasLimit =
      marginedGas > MAX_TX_GAS_LIMIT ? MAX_TX_GAS_LIMIT : marginedGas;

    const preparedCall: CallTxKind =
      resolvedGasLimit === baseCall.gas_limit
        ? baseCall
        : {
            ...baseCall,
            gas_limit: resolvedGasLimit,
            gasLimit: resolvedGasLimit,
          };

    const estimatedTxSize = estimateCallTxSize(preparedCall);
    prebuiltCalls.push({
      preparedCall,
      resolvedGasLimit,
      estimatedTxSize,
    });
  }

  const needsFeeEstimate = explicitFeeRate === undefined;
  const needsNonce =
    explicitStartNonce === undefined && options.sender !== undefined;

  const [fetchedFeeRate, fetchedNonce] = await Promise.all([
    needsFeeEstimate
      ? client.estimateFee(options.requestOptions)
      : Promise.resolve(undefined),
    needsNonce
      ? client.getNonce(options.sender!, options.requestOptions)
      : Promise.resolve(undefined),
  ]);

  const feeRatePerByte = explicitFeeRate ?? fetchedFeeRate!;
  if (feeRatePerByte < 0n) {
    throw new RangeError(
      `Estimated fee rate must be non-negative, got ${feeRatePerByte}`,
    );
  }

  const startNonce = explicitStartNonce ?? fetchedNonce;
  if (startNonce !== undefined && startNonce < 0n) {
    throw new RangeError(`Fetched startNonce must be non-negative, got ${startNonce}`);
  }

  const chainId = options.chainId ?? CHAIN_IDS.MAINNET;
  const preparedBatch: PreparedCallTransaction[] = [];
  let totalFee = 0n;
  let totalGasLimit = 0n;
  let totalEstimatedTxSize = 0;

  for (let i = 0; i < prebuiltCalls.length; i++) {
    const { preparedCall, resolvedGasLimit, estimatedTxSize } = prebuiltCalls[i]!;
    const baseFee = feeRatePerByte * BigInt(estimatedTxSize);
    const marginedFee = applyBpsCeil(baseFee, feeMarginBps);
    const fee = marginedFee < minFeePerCall ? minFeePerCall : marginedFee;
    const nonce = startNonce !== undefined ? startNonce + BigInt(i) : undefined;

    totalFee += fee;
    totalGasLimit += resolvedGasLimit;
    totalEstimatedTxSize += estimatedTxSize;

    preparedBatch.push({
      call: preparedCall,
      fee,
      feeRatePerByte,
      estimatedTxSize,
      gasLimit: resolvedGasLimit,
      nonce,
      chainId,
    });
  }

  if (maxTotalFee !== undefined && totalFee > maxTotalFee) {
    throw new RangeError(`Computed batch totalFee ${totalFee} exceeds maxTotalFee ${maxTotalFee}`);
  }

  return {
    calls: preparedBatch,
    totalFee,
    totalGasLimit,
    totalEstimatedTxSize,
    feeRatePerByte,
    startNonce,
    chainId,
  };
}

// --- Read-Only Contract Simulation (`kovanica_call` Dry-Run Helper) ---

/**
 * Minimal client interface required by {@link dryRunCall}.
 * Satisfied by {@link KovanicaClient}.
 */
export interface DryRunCallClient {
  call<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<TResult>;
}

export interface DryRunCallOptions<TDecoded = undefined> {
  /**
   * Optional simulated caller address (PRO-21 `kvnc...dag` / `tknc...dag`, 32-byte hex, or 32-byte `Uint8Array`).
   * Validated as a 32-byte public key and formatted as a canonical 64-character PRO-21 `kvnc...dag` address.
   */
  from?: Uint8Array | string;
  /**
   * Optional call value override in atoms (defaults to `call.call_value` / `call.value` / `0n`).
   */
  value?: bigint | number;
  /**
   * Optional gas limit override (defaults to `call.gas_limit` / `call.gasLimit` / {@link DEFAULT_CALL_GAS_LIMIT}).
   */
  gasLimit?: bigint | number;
  /**
   * Optional Bincode / binary response decoder invoked on `rawBytes` when `kovanica_call` succeeds.
   */
  decoder?: (bytes: Uint8Array) => TDecoded;
  /**
   * Optional RPC request options (`timeoutMs`, `signal`) forwarded to `kovanica_call`.
   */
  requestOptions?: RequestOptions;
}

export interface DryRunCallResult<TDecoded = undefined> {
  /** Normalized `0x`-prefixed lowercase hex string returned by `kovanica_call` (e.g. `"0x..."` or `"0x"`). */
  rawHex: string;
  /** Raw return bytes decoded from `rawHex`. */
  rawBytes: Uint8Array;
  /** Typed decoded value produced by `options.decoder(rawBytes)` when a `decoder` is provided. */
  decoded?: TDecoded;
}

/**
 * Simulates a read-only contract call against current node state via `kovanica_call`.
 *
 * - Validates and normalizes `call` (contract address, non-empty method, `Uint8Array` args, value, and gas limit)
 *   plus any optional `from`, `value`, or `gasLimit` overrides before making the RPC request.
 * - Encodes the canonical `kovanica_call` request object (`{ to, from?, entry, method, data, value, gas }`).
 * - Decodes the `0x`-prefixed hex response into `rawBytes` and `rawHex`.
 * - When `options.decoder` is provided, decodes `rawBytes` into typed `TDecoded` (surfacing {@link KovanicaDecodeError} cleanly if malformed).
 */
export async function dryRunCall<TDecoded>(
  client: DryRunCallClient,
  call: CallTxKind | CallTxKindInput,
  options: DryRunCallOptions<TDecoded> & { decoder: (bytes: Uint8Array) => TDecoded },
): Promise<DryRunCallResult<TDecoded> & { decoded: TDecoded }>;
export async function dryRunCall<TDecoded = undefined>(
  client: DryRunCallClient,
  call: CallTxKind | CallTxKindInput,
  options?: DryRunCallOptions<TDecoded>,
): Promise<DryRunCallResult<TDecoded>>;
export async function dryRunCall<TDecoded = undefined>(
  client: DryRunCallClient,
  call: CallTxKind | CallTxKindInput,
  options: DryRunCallOptions<TDecoded> = {},
): Promise<DryRunCallResult<TDecoded>> {
  if (!call || typeof call !== "object") {
    throw new TypeError("dryRunCall requires a valid call object");
  }
  if (typeof call.method !== "string" || call.method.trim().length === 0) {
    throw new Error("Call method must be a non-empty string");
  }
  if (!(call.args instanceof Uint8Array)) {
    throw new TypeError("Call args must be a Uint8Array");
  }

  const resolvedInput: CallTxKindInput = {
    contract: call.contract,
    method: call.method.trim(),
    args: call.args,
    call_value: options.value !== undefined ? options.value : (call.call_value ?? call.value),
    gas_limit:
      options.gasLimit !== undefined ? options.gasLimit : (call.gas_limit ?? call.gasLimit),
  };

  const builtCall = buildCallTxKind(resolvedInput);
  if (builtCall.call_value > 0xffffffffffffffffn) {
    throw new RangeError(`call_value out of range for u64: ${builtCall.call_value}`);
  }

  let fromAddress: string | undefined;
  if (options.from !== undefined) {
    const fromBytes = parseContractAddress(options.from);
    fromAddress = encodeAddress(fromBytes);
  }

  const toAddress = encodeAddress(builtCall.contract);
  const dataHex = `0x${bytesToHex(builtCall.args)}`;

  const rpcCallObj: Record<string, string> = {
    to: toAddress,
    entry: builtCall.method,
    method: builtCall.method,
    data: dataHex,
    value: toHexQuantity(builtCall.call_value),
    gas: toHexQuantity(builtCall.gas_limit),
  };
  if (fromAddress !== undefined) {
    rpcCallObj.from = fromAddress;
  }

  const rawResult = await client.call<unknown>(
    "kovanica_call",
    [rpcCallObj],
    options.requestOptions,
  );

  if (typeof rawResult !== "string") {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "kovanica_call: expected hex string response",
    );
  }

  const trimmed = rawResult.trim();
  const cleanHex =
    trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;

  if (cleanHex.length > 0 && (cleanHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(cleanHex))) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "kovanica_call: invalid hex string in response",
    );
  }

  const rawBytes = cleanHex.length === 0 ? new Uint8Array(0) : hexToBytes(cleanHex);
  const rawHex = `0x${cleanHex.toLowerCase()}`;

  if (options.decoder) {
    const decoded = options.decoder(rawBytes);
    return {
      rawHex,
      rawBytes,
      decoded,
    };
  }

  return {
    rawHex,
    rawBytes,
  };
}

// --- Batch Read-Only Contract Simulation (`dryRunBatchCalls`) ---

/**
 * Input item for {@link dryRunBatchCalls}: either a direct {@link CallTxKind} / {@link CallTxKindInput}
 * or a wrapper `{ call: CallTxKind | CallTxKindInput; options?: DryRunCallOptions<TDecoded> }` with per-call
 * `from`, `value`, `gasLimit`, `decoder`, or `requestOptions` overrides.
 */
export type DryRunBatchCallItem<TDecoded = unknown> =
  | CallTxKind
  | CallTxKindInput
  | {
      call: CallTxKind | CallTxKindInput;
      options?: DryRunCallOptions<TDecoded>;
    };

export interface DryRunBatchCallsOptions {
  /**
   * When `true`, executes all dry-run calls concurrently via `Promise.all`.
   * When `false` (default), executes calls sequentially in input order.
   */
  parallel?: boolean;
  /**
   * When `true` (default), captures individual call failures as `{ ok: false, error: Error }`
   * instead of aborting the batch.
   * When `false`, re-throws the first encountered error.
   */
  continueOnError?: boolean;
  /**
   * Optional default simulated caller address applied to calls that do not specify their own `options.from`.
   */
  from?: Uint8Array | string;
  /**
   * Optional default gas limit override applied to calls that do not specify their own `options.gasLimit`
   * or explicit `call.gas_limit` / `call.gasLimit`.
   */
  gasLimit?: bigint | number;
  /**
   * Optional default RPC request options (`timeoutMs`, `signal`) forwarded to calls that do not specify
   * their own `options.requestOptions`.
   */
  requestOptions?: RequestOptions;
}

export type BatchDryRunItemResult<TDecoded = unknown> =
  | {
      ok: true;
      result: DryRunCallResult<TDecoded>;
    }
  | {
      ok: false;
      error: Error;
    };

export interface BatchDryRunResult<TDecoded = unknown> {
  /** Per-call dry-run outcomes in input order. */
  results: Array<BatchDryRunItemResult<TDecoded>>;
  /** Total number of calls in the batch (`results.length`). */
  totalCalls: number;
  /** Count of calls that succeeded (`ok: true`). */
  passedCount: number;
  /** Count of calls that failed (`ok: false`). */
  failedCount: number;
}

function isWrappedBatchItem<TDecoded>(
  item: DryRunBatchCallItem<TDecoded>,
): item is { call: CallTxKind | CallTxKindInput; options?: DryRunCallOptions<TDecoded> } {
  return (
    typeof item === "object" &&
    item !== null &&
    "call" in item &&
    typeof (item as { call?: unknown }).call === "object" &&
    (item as { call?: unknown }).call !== null &&
    !("contract" in item && "method" in item && "args" in item)
  );
}

function validateDryRunInputsFailClosed<TDecoded>(
  call: CallTxKind | CallTxKindInput,
  callOptions: DryRunCallOptions<TDecoded>,
  index: number,
): void {
  if (!call || typeof call !== "object") {
    throw new TypeError(`dryRunBatchCalls: call at index ${index} must be a valid call object`);
  }
  if (typeof call.method !== "string" || call.method.trim().length === 0) {
    throw new Error(`dryRunBatchCalls: call at index ${index} method must be a non-empty string`);
  }
  if (!(call.args instanceof Uint8Array)) {
    throw new TypeError(`dryRunBatchCalls: call at index ${index} args must be a Uint8Array`);
  }

  const resolvedInput: CallTxKindInput = {
    contract: call.contract,
    method: call.method.trim(),
    args: call.args,
    call_value:
      callOptions.value !== undefined ? callOptions.value : (call.call_value ?? call.value),
    gas_limit:
      callOptions.gasLimit !== undefined
        ? callOptions.gasLimit
        : (call.gas_limit ?? call.gasLimit),
  };

  const builtCall = buildCallTxKind(resolvedInput);
  if (builtCall.call_value > 0xffffffffffffffffn) {
    throw new RangeError(
      `dryRunBatchCalls: call at index ${index} call_value out of range for u64: ${builtCall.call_value}`,
    );
  }

  if (callOptions.from !== undefined) {
    const fromBytes = parseContractAddress(callOptions.from);
    encodeAddress(fromBytes);
  }
  if (callOptions.decoder !== undefined && typeof callOptions.decoder !== "function") {
    throw new TypeError(
      `dryRunBatchCalls: call at index ${index} decoder must be a function when provided`,
    );
  }
}

/**
 * Simulates a non-empty batch of read-only contract calls via {@link dryRunCall}.
 *
 * - Validates all calls and options fail-closed before any RPC I/O.
 * - Executes {@link dryRunCall} for each item sequentially by default, or in parallel when `options.parallel === true`.
 * - When `options.continueOnError !== false` (the default), captures individual results as
 *   `{ ok: true, result }` or `{ ok: false, error }`.
 * - When `options.continueOnError === false`, throws on the first encountered error.
 * - Returns {@link BatchDryRunResult}: `{ results, totalCalls, passedCount, failedCount }`.
 */
export async function dryRunBatchCalls<TDecoded = unknown>(
  client: DryRunCallClient,
  calls: ReadonlyArray<DryRunBatchCallItem<TDecoded>>,
  options: DryRunBatchCallsOptions = {},
): Promise<BatchDryRunResult<TDecoded>> {
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new RangeError("dryRunBatchCalls requires a non-empty array of calls");
  }
  if (!options || typeof options !== "object") {
    throw new TypeError("dryRunBatchCalls: options must be an object when provided");
  }

  // Validate batch-level default `from` and `gasLimit` up front
  if (options.from !== undefined) {
    encodeAddress(parseContractAddress(options.from));
  }
  if (options.gasLimit !== undefined) {
    const g = BigInt(options.gasLimit);
    if (g < 0n) {
      throw new Error(`gas_limit must be non-negative, got ${g}`);
    }
    if (g > MAX_TX_GAS_LIMIT) {
      throw new Error(`gas_limit ${g} exceeds maximum allowed ${MAX_TX_GAS_LIMIT}`);
    }
  }

  const normalizedItems: Array<{
    call: CallTxKind | CallTxKindInput;
    callOptions: DryRunCallOptions<TDecoded>;
  }> = [];

  for (let i = 0; i < calls.length; i++) {
    const rawItem = calls[i]!;
    if (!rawItem || typeof rawItem !== "object") {
      throw new TypeError(`dryRunBatchCalls: item at index ${i} must be a valid call object`);
    }

    let call: CallTxKind | CallTxKindInput;
    let itemOptions: DryRunCallOptions<TDecoded> | undefined;
    if (isWrappedBatchItem<TDecoded>(rawItem)) {
      call = rawItem.call;
      itemOptions = rawItem.options;
    } else {
      call = rawItem;
      itemOptions = undefined;
    }

    const hasExplicitCallGas =
      call &&
      typeof call === "object" &&
      (call.gas_limit !== undefined || call.gasLimit !== undefined);

    const mergedOptions: DryRunCallOptions<TDecoded> = {
      from: itemOptions?.from !== undefined ? itemOptions.from : options.from,
      value: itemOptions?.value,
      gasLimit:
        itemOptions?.gasLimit !== undefined
          ? itemOptions.gasLimit
          : !hasExplicitCallGas && options.gasLimit !== undefined
            ? options.gasLimit
            : undefined,
      decoder: itemOptions?.decoder,
      requestOptions:
        itemOptions?.requestOptions !== undefined
          ? itemOptions.requestOptions
          : options.requestOptions,
    };

    validateDryRunInputsFailClosed(call, mergedOptions, i);
    normalizedItems.push({ call, callOptions: mergedOptions });
  }

  const continueOnError = options.continueOnError !== false;
  const parallel = options.parallel === true;

  const executeOne = async (item: {
    call: CallTxKind | CallTxKindInput;
    callOptions: DryRunCallOptions<TDecoded>;
  }): Promise<BatchDryRunItemResult<TDecoded>> => {
    try {
      const result = await dryRunCall<TDecoded>(client, item.call, item.callOptions);
      return { ok: true, result };
    } catch (err) {
      if (!continueOnError) {
        throw err;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      return { ok: false, error };
    }
  };

  let results: Array<BatchDryRunItemResult<TDecoded>>;
  if (parallel) {
    results = await Promise.all(normalizedItems.map((item) => executeOne(item)));
  } else {
    results = [];
    for (const item of normalizedItems) {
      results.push(await executeOne(item));
    }
  }

  let passedCount = 0;
  let failedCount = 0;
  for (const res of results) {
    if (res.ok) {
      passedCount += 1;
    } else {
      failedCount += 1;
    }
  }

  return {
    results,
    totalCalls: results.length,
    passedCount,
    failedCount,
  };
}

// --- Transaction Receipt Poller (`waitForTransactionReceipt`) ---

/** Default polling interval in milliseconds for {@link waitForTransactionReceipt} (`1_000` ms). */
export const DEFAULT_RECEIPT_POLL_INTERVAL_MS = 1_000;
/** Default maximum wait timeout in milliseconds for {@link waitForTransactionReceipt} (`30_000` ms). */
export const DEFAULT_RECEIPT_TIMEOUT_MS = 30_000;
/** Minimum allowed polling interval in milliseconds for {@link waitForTransactionReceipt} (`10` ms). */
export const MIN_RECEIPT_POLL_INTERVAL_MS = 10;

/**
 * Minimal client interface required by {@link waitForTransactionReceipt}.
 * Satisfied by {@link KovanicaClient}.
 */
export interface WaitForTransactionReceiptClient {
  getTransactionReceipt(
    hash: string,
    options?: RequestOptions,
  ): Promise<TransactionReceipt | null>;
}

export interface WaitForTransactionReceiptOptions {
  /**
   * Polling interval in milliseconds between `getTransactionReceipt` calls.
   * Must be an integer >= {@link MIN_RECEIPT_POLL_INTERVAL_MS} (`10` ms).
   * Default: {@link DEFAULT_RECEIPT_POLL_INTERVAL_MS} (`1_000` ms).
   */
  pollIntervalMs?: number;
  /**
   * Maximum total wait time in milliseconds before throwing {@link KovanicaTimeoutError}.
   * Must be a positive integer.
   * Default: {@link DEFAULT_RECEIPT_TIMEOUT_MS} (`30_000` ms).
   */
  timeoutMs?: number;
  /**
   * Optional cancellation signal. Aborts immediately during poll wait sleep as well as RPC calls
   * with {@link KovanicaAbortError}.
   */
  signal?: AbortSignal;
  /**
   * When `true` and the returned receipt indicates a reverted or failed execution
   * (`receipt.success === false` or `receipt.status === 0`), throws a descriptive
   * {@link KovanicaRpcError} (`RpcErrorCode.ExecutionError`, `-32000`).
   * Default: `false`.
   */
  throwOnRevert?: boolean;
}

function normalizeAndValidateTxHash(txHash: string): string {
  if (typeof txHash !== "string") {
    throw new TypeError("Invalid transaction hash: expected a 32-byte hex string");
  }
  const trimmed = txHash.trim();
  const clean =
    trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  if (clean.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(
      `Invalid transaction hash: expected 32-byte (64-character) hex string, got "${txHash}"`,
    );
  }
  return `0x${clean.toLowerCase()}`;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new KovanicaAbortError());
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new KovanicaAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Polls `client.getTransactionReceipt(txHash)` until a non-null {@link TransactionReceipt}
 * is returned or `options.timeoutMs` elapses.
 *
 * - Validates `txHash` as a 32-byte (64-character) hex string (with or without `0x` prefix).
 * - Polls at `options.pollIntervalMs` (default `1_000` ms, minimum `10` ms) up to `options.timeoutMs` (default `30_000` ms).
 * - Honors `options.signal` (`AbortSignal`), aborting immediately with {@link KovanicaAbortError} both during RPC requests and during poll sleep intervals.
 * - When `options.throwOnRevert` is `true` and the receipt indicates reverted/failed status (`!receipt.success || receipt.status === 0`),
 *   throws a descriptive {@link KovanicaRpcError} (`RpcErrorCode.ExecutionError`).
 */
export async function waitForTransactionReceipt(
  client: WaitForTransactionReceiptClient,
  txHash: string,
  options: WaitForTransactionReceiptOptions = {},
): Promise<TransactionReceipt> {
  const normalizedHash = normalizeAndValidateTxHash(txHash);

  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_RECEIPT_POLL_INTERVAL_MS;
  if (
    typeof pollIntervalMs !== "number" ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < MIN_RECEIPT_POLL_INTERVAL_MS
  ) {
    throw new RangeError(
      `pollIntervalMs must be an integer >= ${MIN_RECEIPT_POLL_INTERVAL_MS}, got ${pollIntervalMs}`,
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new RangeError(`timeoutMs must be a positive integer, got ${timeoutMs}`);
  }

  const { signal, throwOnRevert = false } = options;
  if (signal?.aborted) {
    throw new KovanicaAbortError();
  }

  const deadline = Date.now() + timeoutMs;
  const requestOptions: RequestOptions | undefined = signal ? { signal } : undefined;

  while (true) {
    if (signal?.aborted) {
      throw new KovanicaAbortError();
    }

    const receipt = await client.getTransactionReceipt(normalizedHash, requestOptions);

    if (signal?.aborted) {
      throw new KovanicaAbortError();
    }

    if (receipt !== null) {
      if (throwOnRevert && (!receipt.success || receipt.status === 0)) {
        throw new KovanicaRpcError(
          RpcErrorCode.ExecutionError,
          `Transaction ${normalizedHash} reverted or failed with status ${receipt.status} at block ${receipt.blockNumber}`,
          { receipt, transactionHash: normalizedHash },
        );
      }
      return receipt;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new KovanicaTimeoutError(
        timeoutMs,
        `Timed out waiting for transaction receipt for ${normalizedHash} after ${timeoutMs}ms`,
      );
    }

    const sleepMs = Math.min(pollIntervalMs, remainingMs);
    await sleepWithAbort(sleepMs, signal);

    if (Date.now() >= deadline) {
      throw new KovanicaTimeoutError(
        timeoutMs,
        `Timed out waiting for transaction receipt for ${normalizedHash} after ${timeoutMs}ms`,
      );
    }
  }
}
