/**
 * Offline Signed Call Transaction Decoder & RFC 8032 Ed25519 Signature Verifier
 *
 * Parses the canonical Bincode 1.x wire format produced by `signCallContractTransaction`
 * and verifies the 64-byte Ed25519 signature over the recomputed domain-tagged BLAKE3
 * signing hash without any network or Node-only dependencies.
 */

import { sha512 } from "@noble/hashes/sha2.js";
import { encodeAddress } from "./address";
import { CHAIN_IDS } from "./chains";
import {
  type CallTxKind,
  bytesToHex,
  computeCallTransactionSigningHash,
  concatBytes,
  hexToBytes,
} from "./contracts";
import { BincodeReader, KovanicaDecodeError } from "./decoders";

const CALL_TX_VARIANT_INDEX = 6;
const MAX_METHOD_BYTES = 1024;
const MAX_ARGS_BYTES = 16 * 1024 * 1024;

export interface DecodeSignedCallTransactionOptions {
  /**
   * Chain ID used when recomputing the domain-tagged BLAKE3 signing hash.
   * Defaults to `CHAIN_IDS.MAINNET` (`1`).
   */
  chainId?: number;
}

export interface DecodedSignedCallTransaction {
  senderBytes: Uint8Array;
  senderHex: string;
  senderAddress: string;
  nonce: bigint;
  fee: bigint;
  contractBytes: Uint8Array;
  contractHex: string;
  contractAddress: string;
  method: string;
  callValue: bigint;
  args: Uint8Array;
  argsHex: string;
  gasLimit: bigint;
  signature: Uint8Array;
  signatureHex: string;
  signingHash: Uint8Array;
  signingHashHex: string;
  wireHash: Uint8Array;
  wireHashHex: string;
  chainId: number;
  wireSizeBytes: number;
}

// --- Pure-TypeScript RFC 8032 Ed25519 Verification ---

const ED_P = 2n ** 255n - 19n;
const ED_L = (1n << 252n) + 27742317777372353535851937790883648493n;
const ED_P_MINUS_5_DIV_8 = (ED_P - 5n) / 8n;

type ExtendedPoint = [bigint, bigint, bigint, bigint];

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let res = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) res = (res * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return res;
}

function modInverse(n: bigint, m: bigint): bigint {
  return modPow(n, m - 2n, m);
}

const ED_D = mod(-121665n * modInverse(121666n, ED_P), ED_P);
const ED_I = modPow(2n, (ED_P - 1n) / 4n, ED_P);

function recoverBaseX(y: bigint): bigint {
  const y2 = (y * y) % ED_P;
  const u = mod(y2 - 1n, ED_P);
  const v = (ED_D * y2 + 1n) % ED_P;
  const uv = (u * modInverse(v, ED_P)) % ED_P;
  let x = modPow(uv, (ED_P + 3n) / 8n, ED_P);
  if (mod(x * x - uv, ED_P) !== 0n) {
    x = (x * ED_I) % ED_P;
  }
  if ((x & 1n) !== 0n) {
    x = ED_P - x;
  }
  return x;
}

const ED_BY = (4n * modInverse(5n, ED_P)) % ED_P;
const ED_BX = recoverBaseX(ED_BY);
const ED_B: ExtendedPoint = [ED_BX, ED_BY, 1n, (ED_BX * ED_BY) % ED_P];

function pointAdd(p1: ExtendedPoint, p2: ExtendedPoint): ExtendedPoint {
  const [X1, Y1, Z1, T1] = p1;
  const [X2, Y2, Z2, T2] = p2;
  const A = (mod(Y1 - X1, ED_P) * mod(Y2 - X2, ED_P)) % ED_P;
  const B = ((Y1 + X1) * (Y2 + X2)) % ED_P;
  const C = (2n * T1 * T2 * ED_D) % ED_P;
  const D = (2n * Z1 * Z2) % ED_P;
  const E = mod(B - A, ED_P);
  const F = mod(D - C, ED_P);
  const G = (D + C) % ED_P;
  const H = (B + A) % ED_P;
  return [(E * F) % ED_P, (G * H) % ED_P, (F * G) % ED_P, (E * H) % ED_P];
}

function pointDouble(p: ExtendedPoint): ExtendedPoint {
  const [X1, Y1, Z1] = p;
  const A = (X1 * X1) % ED_P;
  const B = (Y1 * Y1) % ED_P;
  const C = (2n * Z1 * Z1) % ED_P;
  const D = mod(-A, ED_P);
  const E = mod((X1 + Y1) * (X1 + Y1) - A - B, ED_P);
  const G = (D + B) % ED_P;
  const F = mod(G - C, ED_P);
  const H = mod(D - B, ED_P);
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

function pointEqual(p1: ExtendedPoint, p2: ExtendedPoint): boolean {
  const [X1, Y1, Z1] = p1;
  const [X2, Y2, Z2] = p2;
  return (X1 * Z2) % ED_P === (X2 * Z1) % ED_P && (Y1 * Z2) % ED_P === (Y2 * Z1) % ED_P;
}

function bytesToBigintLE(bytes: Uint8Array): bigint {
  let res = 0n;
  for (let i = 0; i < bytes.length; i++) {
    res |= BigInt(bytes[i]!) << BigInt(8 * i);
  }
  return res;
}

function decodePoint(bytes: Uint8Array): ExtendedPoint | null {
  if (bytes.length !== 32) return null;

  const signBit = (bytes[31]! & 0x80) !== 0 ? 1n : 0n;
  let y = 0n;
  for (let i = 0; i < 31; i++) {
    y |= BigInt(bytes[i]!) << BigInt(8 * i);
  }
  y |= BigInt(bytes[31]! & 0x7f) << 248n;

  if (y >= ED_P) return null;

  const y2 = (y * y) % ED_P;
  const u = mod(y2 - 1n, ED_P);
  const v = (ED_D * y2 + 1n) % ED_P;

  // RFC 8032 Section 5.1.3: x = (u * v^3) * (u * v^7)^((p - 5) / 8) mod p
  const v2 = (v * v) % ED_P;
  const v3 = (v2 * v) % ED_P;
  const v7 = (((v3 * v3) % ED_P) * v) % ED_P;
  const uv3 = (u * v3) % ED_P;
  const uv7 = (u * v7) % ED_P;

  let x = (uv3 * modPow(uv7, ED_P_MINUS_5_DIV_8, ED_P)) % ED_P;
  const vx2 = (v * ((x * x) % ED_P)) % ED_P;

  if (vx2 !== u) {
    if (vx2 === mod(-u, ED_P)) {
      x = (x * ED_I) % ED_P;
    } else {
      return null;
    }
  }

  if (x === 0n && signBit === 1n) {
    return null;
  }

  if ((x & 1n) !== signBit) {
    x = ED_P - x;
  }

  return [x, y, 1n, (x * y) % ED_P];
}

/**
 * Pure TypeScript RFC 8032 Ed25519 signature verification.
 * Never throws on malformed keys or signatures; returns `false` on any invalid input.
 */
export function verifyEd25519(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    if (
      !(signature instanceof Uint8Array) ||
      !(message instanceof Uint8Array) ||
      !(publicKey instanceof Uint8Array)
    ) {
      return false;
    }
    if (signature.length !== 64 || publicKey.length !== 32) {
      return false;
    }

    const rBytes = signature.subarray(0, 32);
    const sBytes = signature.subarray(32, 64);

    const s = bytesToBigintLE(sBytes);
    if (s >= ED_L) {
      return false;
    }

    const A = decodePoint(publicKey);
    if (!A) return false;

    const R = decodePoint(rBytes);
    if (!R) return false;

    const kHash = sha512(concatBytes([rBytes, publicKey, message]));
    const k = bytesToBigintLE(kHash) % ED_L;

    const lhs = scalarMult(s, ED_B);
    const rhs = pointAdd(R, scalarMult(k, A));
    return pointEqual(lhs, rhs);
  } catch {
    return false;
  }
}

// --- Input Normalization ---

function normalizeRawTxBytes(rawTx: string | Uint8Array): Uint8Array {
  if (rawTx instanceof Uint8Array) {
    return rawTx;
  }
  if (typeof rawTx === "string") {
    const trimmed = rawTx.trim();
    const hex = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
    if (hex.length === 0) {
      return new Uint8Array(0);
    }
    if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new KovanicaDecodeError(
        "INVALID_INPUT",
        "decodeSignedCallTransaction: invalid hex string",
      );
    }
    return hexToBytes(hex);
  }
  throw new KovanicaDecodeError(
    "INVALID_INPUT",
    "decodeSignedCallTransaction: expected Uint8Array or hex string",
  );
}

// --- Offline Signed Call Transaction Decoder & Verifier ---

/**
 * Decodes a signed Call contract transaction from its canonical Bincode 1.x wire representation
 * (as produced by `signCallContractTransaction`).
 *
 * Fails closed with `KovanicaDecodeError` on invalid hex, truncated bytes, unexpected
 * `TransactionKind` discriminant, invalid UTF-8 method name, wrong signature length, or trailing bytes.
 */
export function decodeSignedCallTransaction(
  rawTx: string | Uint8Array,
  options?: DecodeSignedCallTransactionOptions,
): DecodedSignedCallTransaction {
  const bytes = normalizeRawTxBytes(rawTx);
  const reader = new BincodeReader(bytes);

  const senderBytes = reader.readFixedBytes(32, "SignedCallTransaction.sender");
  const nonce = reader.readU64("SignedCallTransaction.nonce");

  const variantOffset = reader.offset;
  const variant = reader.readU32("SignedCallTransaction.kind.variant");
  if (variant !== CALL_TX_VARIANT_INDEX) {
    throw new KovanicaDecodeError(
      "INVALID_VARIANT",
      `Expected TransactionKind::Call variant ${CALL_TX_VARIANT_INDEX}, got ${variant} at offset ${variantOffset}`,
      { offset: variantOffset, field: "SignedCallTransaction.kind.variant" },
    );
  }

  const contractBytes = reader.readFixedBytes(32, "SignedCallTransaction.kind.contract");
  const callValue = reader.readU64("SignedCallTransaction.kind.call_value");
  const method = reader.readString(MAX_METHOD_BYTES, "SignedCallTransaction.kind.method");
  const args = reader.readBytes(MAX_ARGS_BYTES, "SignedCallTransaction.kind.args");
  const gasLimit = reader.readU64("SignedCallTransaction.kind.gas_limit");
  const fee = reader.readU64("SignedCallTransaction.fee");

  const sigOffset = reader.offset;
  const signature = reader.readBytes(64, "SignedCallTransaction.signature");
  if (signature.length !== 64) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      `Expected 64-byte Ed25519 signature, got ${signature.length} byte(s) at offset ${sigOffset}`,
      { offset: sigOffset, field: "SignedCallTransaction.signature" },
    );
  }

  const wireHash = reader.readFixedBytes(32, "SignedCallTransaction.wireHash");
  reader.assertEof("SignedCallTransaction");

  const chainId = options?.chainId ?? CHAIN_IDS.MAINNET;
  const callKind: CallTxKind = {
    type: "call",
    contract: contractBytes,
    method,
    args,
    call_value: callValue,
    value: callValue,
    gas_limit: gasLimit,
    gasLimit,
  };

  const signingHash = computeCallTransactionSigningHash(
    {
      sender: senderBytes,
      nonce,
      call: callKind,
      fee,
    },
    chainId,
  );

  return {
    senderBytes,
    senderHex: `0x${bytesToHex(senderBytes)}`,
    senderAddress: encodeAddress(senderBytes),
    nonce,
    fee,
    contractBytes,
    contractHex: `0x${bytesToHex(contractBytes)}`,
    contractAddress: encodeAddress(contractBytes),
    method,
    callValue,
    args,
    argsHex: `0x${bytesToHex(args)}`,
    gasLimit,
    signature,
    signatureHex: `0x${bytesToHex(signature)}`,
    signingHash,
    signingHashHex: `0x${bytesToHex(signingHash)}`,
    wireHash,
    wireHashHex: `0x${bytesToHex(wireHash)}`,
    chainId,
    wireSizeBytes: bytes.length,
  };
}

/**
 * Verifies the 64-byte Ed25519 signature on a decoded Call transaction against `decoded.signingHash`.
 *
 * Uses `publicKey` when supplied, otherwise verifies against `decoded.senderBytes` (which holds
 * the signer's 32-byte Ed25519 public key in canonical Kovanica transactions).
 *
 * Never throws on invalid keys or signature bytes; returns `false`.
 */
export function verifyCallTransactionSignature(
  decoded: DecodedSignedCallTransaction,
  publicKey?: Uint8Array,
): boolean {
  try {
    if (!decoded || typeof decoded !== "object") {
      return false;
    }
    const pubkey = publicKey ?? decoded.senderBytes;
    if (
      !(pubkey instanceof Uint8Array) ||
      !(decoded.signature instanceof Uint8Array) ||
      !(decoded.signingHash instanceof Uint8Array)
    ) {
      return false;
    }
    if (
      pubkey.length !== 32 ||
      decoded.signature.length !== 64 ||
      decoded.signingHash.length !== 32
    ) {
      return false;
    }
    return verifyEd25519(decoded.signature, decoded.signingHash, pubkey);
  } catch {
    return false;
  }
}
