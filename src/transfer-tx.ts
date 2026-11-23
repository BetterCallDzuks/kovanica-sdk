/**
 * Offline Native Transfer Transaction Signer, Decoder & RFC 8032 Ed25519 Signature Verifier
 *
 * Matches canonical L1 `Transaction` / `TransactionKind::Transfer` wire layout and
 * signature format v1 in `kovanica-l1/crates/kovanica-types/src/transaction.rs`
 * without any network or Node-only dependencies.
 */

import { blake3 } from "@noble/hashes/blake3.js";
import { encodeAddress } from "./address";
import { CHAIN_IDS } from "./chains";
import {
  TX_DOMAIN,
  TX_KEY,
  bytesToHex,
  concatBytes,
  hexToBytes,
  parseContractAddress,
  signEd25519,
  u32le,
  u64le,
} from "./contracts";
import { BincodeReader, KovanicaDecodeError } from "./decoders";
import { verifyEd25519 } from "./tx-decode";
import { getPublicKey } from "./wallet";

/** Bincode 1.x enum variant discriminant for `TransactionKind::Transfer` on L1. */
export const TRANSFER_TX_VARIANT = 0;

/** Single-byte tag for `TransactionKind::Transfer` in the signature format v1 signing preimage. */
export const TRANSFER_TX_SIGNING_TAG = 0;

/**
 * Exact canonical wire byte size of a signed `TransactionKind::Transfer` transaction:
 * 32 (sender) + 8 (nonce) + 4 (variant u32) + 32 (to) + 8 (amount u64) +
 * 8 (fee u64) + 8 (sig len u64) + 64 (signature) + 32 (wireHash) = 196 bytes.
 */
export const TRANSFER_TX_WIRE_SIZE = 196;

export interface TransferSigningHashParams {
  /** Sender 32-byte public key, PRO-21 address (`kvnc...dag` / `tknc...dag`), or 32-byte hex string. */
  sender: Uint8Array | string;
  /** Recipient 32-byte public key, PRO-21 address (`kvnc...dag` / `tknc...dag`), or 32-byte hex string. */
  to: Uint8Array | string;
  /** Transfer amount in base units (atoms, u64). */
  amount: bigint | number;
  /** Sender nonce (u64). */
  nonce: bigint | number;
  /** Transaction fee in base units (atoms, u64). */
  fee: bigint | number;
  /** Chain ID committed into the signing preimage. Defaults to `CHAIN_IDS.MAINNET` (`1`). */
  chainId?: bigint | number;
}

export interface SignTransferTxParams {
  /** 32-byte Ed25519 secret key (sender public key is derived automatically). */
  privateKey: Uint8Array;
  /** Recipient 32-byte public key, PRO-21 address (`kvnc...dag` / `tknc...dag`), or 32-byte hex string. */
  to: Uint8Array | string;
  /** Transfer amount in base units (atoms, u64). */
  amount: bigint | number;
  /** Sender nonce (u64). */
  nonce: bigint | number;
  /** Transaction fee in base units (atoms, u64). */
  fee: bigint | number;
  /** Chain ID committed into the signing preimage. Defaults to `CHAIN_IDS.MAINNET` (`1`). */
  chainId?: bigint | number;
}

export interface SignedTransferTxResult {
  rawTxBytes: Uint8Array;
  rawTxHex: string;
  signingHash: Uint8Array;
  signingHashHex: string;
  signature: Uint8Array;
  signatureHex: string;
  senderBytes: Uint8Array;
  senderAddress: string;
  recipientBytes: Uint8Array;
  recipientAddress: string;
}

export interface DecodeSignedTransferTransactionOptions {
  /**
   * Chain ID used when recomputing the domain-tagged BLAKE3 signing hash.
   * Defaults to `CHAIN_IDS.MAINNET` (`1`).
   */
  chainId?: bigint | number;
}

export interface DecodedSignedTransferTransaction {
  senderBytes: Uint8Array;
  senderHex: string;
  senderAddress: string;
  nonce: bigint;
  fee: bigint;
  recipientBytes: Uint8Array;
  recipientHex: string;
  recipientAddress: string;
  amount: bigint;
  signature: Uint8Array;
  signatureHex: string;
  signingHash: Uint8Array;
  signingHashHex: string;
  wireHash: Uint8Array;
  wireHashHex: string;
  chainId: bigint;
  wireSizeBytes: number;
}

// --- Internal Helpers ---

function resolveAddressBytes(addr: Uint8Array | string, label: string): Uint8Array {
  if (addr instanceof Uint8Array) {
    if (addr.length !== 32) {
      throw new Error(`Expected 32-byte ${label} address, got ${addr.length}`);
    }
    return new Uint8Array(addr);
  }
  if (typeof addr === "string") {
    return parseContractAddress(addr);
  }
  throw new Error(`Invalid ${label} address: expected Uint8Array or string`);
}

function normalizeU64(value: bigint | number, field: string): bigint {
  if (typeof value === "number" && !Number.isInteger(value)) {
    throw new RangeError(`${field} must be an integer, got ${value}`);
  }
  const b = BigInt(value);
  if (b < 0n || b > 0xffffffffffffffffn) {
    throw new RangeError(`${field} out of range for u64: ${value}`);
  }
  return b;
}

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
        "decodeSignedTransferTransaction: invalid hex string",
      );
    }
    return hexToBytes(hex);
  }
  throw new KovanicaDecodeError(
    "INVALID_INPUT",
    "decodeSignedTransferTransaction: expected Uint8Array or hex string",
  );
}

// --- Signing Hash, Signer, Decoder & Verifier ---

/**
 * Computes the domain-tagged BLAKE3 signing hash (signature format v1) for a native
 * `TransactionKind::Transfer` transaction.
 *
 * Preimage layout (`kovanica-types/src/transaction.rs`):
 * `TX_DOMAIN (16B) || chain_id (u64 LE) || sender (32B) || nonce (u64 LE) || 0u8 || to (32B) || amount (u64 LE) || fee (u64 LE)`
 */
export function computeTransferTransactionSigningHash(
  tx: TransferSigningHashParams,
  chainId?: bigint | number,
): Uint8Array {
  const senderBytes = resolveAddressBytes(tx.sender, "sender");
  const recipientBytes = resolveAddressBytes(tx.to, "recipient");
  const resolvedChainId = normalizeU64(
    chainId ?? tx.chainId ?? CHAIN_IDS.MAINNET,
    "chainId",
  );
  const nonce = normalizeU64(tx.nonce, "nonce");
  const amount = normalizeU64(tx.amount, "amount");
  const fee = normalizeU64(tx.fee, "fee");

  const preimage = concatBytes([
    TX_DOMAIN,
    u64le(resolvedChainId),
    senderBytes,
    u64le(nonce),
    Uint8Array.of(TRANSFER_TX_SIGNING_TAG),
    recipientBytes,
    u64le(amount),
    u64le(fee),
  ]);
  return blake3(preimage, { key: TX_KEY });
}

/**
 * Constructs, signs, and Bincode-serializes a native `TransactionKind::Transfer` transaction offline.
 */
export function signTransferTransaction(params: SignTransferTxParams): SignedTransferTxResult {
  if (!(params.privateKey instanceof Uint8Array) || params.privateKey.length !== 32) {
    throw new Error(
      `Private key must be a 32-byte Uint8Array, got ${
        params.privateKey instanceof Uint8Array ? params.privateKey.length : typeof params.privateKey
      }`,
    );
  }

  const senderBytes = getPublicKey(params.privateKey);
  const recipientBytes = resolveAddressBytes(params.to, "recipient");
  const chainId = normalizeU64(params.chainId ?? CHAIN_IDS.MAINNET, "chainId");
  const nonce = normalizeU64(params.nonce, "nonce");
  const amount = normalizeU64(params.amount, "amount");
  const fee = normalizeU64(params.fee, "fee");

  const signingHash = computeTransferTransactionSigningHash(
    {
      sender: senderBytes,
      to: recipientBytes,
      amount,
      nonce,
      fee,
    },
    chainId,
  );

  const signature = signEd25519(signingHash, params.privateKey);

  const rawTxBytes = concatBytes([
    senderBytes,
    u64le(nonce),
    u32le(TRANSFER_TX_VARIANT),
    recipientBytes,
    u64le(amount),
    u64le(fee),
    u64le(64n), // u64 LE length prefix for Signature in bincode
    signature,
    signingHash,
  ]);

  return {
    rawTxBytes,
    rawTxHex: bytesToHex(rawTxBytes),
    signingHash,
    signingHashHex: bytesToHex(signingHash),
    signature,
    signatureHex: bytesToHex(signature),
    senderBytes,
    senderAddress: encodeAddress(senderBytes),
    recipientBytes,
    recipientAddress: encodeAddress(recipientBytes),
  };
}

/**
 * Decodes a signed native Transfer transaction from its canonical Bincode 1.x wire representation
 * (as produced by `signTransferTransaction` and accepted by L1).
 *
 * Fails closed with `KovanicaDecodeError` on invalid hex, truncated bytes, unexpected
 * `TransactionKind` discriminant, wrong signature length, or trailing bytes.
 */
export function decodeSignedTransferTransaction(
  rawTx: string | Uint8Array,
  options?: DecodeSignedTransferTransactionOptions,
): DecodedSignedTransferTransaction {
  const bytes = normalizeRawTxBytes(rawTx);
  const reader = new BincodeReader(bytes);

  const senderBytes = reader.readFixedBytes(32, "SignedTransferTransaction.sender");
  const nonce = reader.readU64("SignedTransferTransaction.nonce");

  const variantOffset = reader.offset;
  const variant = reader.readU32("SignedTransferTransaction.kind.variant");
  if (variant !== TRANSFER_TX_VARIANT) {
    throw new KovanicaDecodeError(
      "INVALID_VARIANT",
      `Expected TransactionKind::Transfer variant ${TRANSFER_TX_VARIANT}, got ${variant} at offset ${variantOffset}`,
      { offset: variantOffset, field: "SignedTransferTransaction.kind.variant" },
    );
  }

  const recipientBytes = reader.readFixedBytes(32, "SignedTransferTransaction.kind.to");
  const amount = reader.readU64("SignedTransferTransaction.kind.amount");
  const fee = reader.readU64("SignedTransferTransaction.fee");

  const sigOffset = reader.offset;
  const signature = reader.readBytes(64, "SignedTransferTransaction.signature");
  if (signature.length !== 64) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      `Expected 64-byte Ed25519 signature, got ${signature.length} byte(s) at offset ${sigOffset}`,
      { offset: sigOffset, field: "SignedTransferTransaction.signature" },
    );
  }

  const wireHash = reader.readFixedBytes(32, "SignedTransferTransaction.wireHash");
  reader.assertEof("SignedTransferTransaction");

  const chainId = normalizeU64(options?.chainId ?? CHAIN_IDS.MAINNET, "chainId");
  const signingHash = computeTransferTransactionSigningHash(
    {
      sender: senderBytes,
      to: recipientBytes,
      amount,
      nonce,
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
    recipientBytes,
    recipientHex: `0x${bytesToHex(recipientBytes)}`,
    recipientAddress: encodeAddress(recipientBytes),
    amount,
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
 * Verifies the 64-byte Ed25519 signature on a decoded Transfer transaction against `decoded.signingHash`.
 *
 * Uses `publicKey` when supplied, otherwise verifies against `decoded.senderBytes` (which holds
 * the signer's 32-byte Ed25519 public key in canonical Kovanica transactions).
 *
 * Never throws on invalid keys or signature bytes; returns `false`.
 */
export function verifyTransferTransactionSignature(
  decoded: DecodedSignedTransferTransaction,
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
