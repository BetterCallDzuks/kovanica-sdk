/**
 * Universal Offline Signed Transaction Auto-Decoder & Signature Verifier
 *
 * Peeks the canonical Bincode 1.x `TransactionKind` discriminant at byte offset 40
 * (`sender[32] || nonce[8]`) and dispatches to the appropriate offline decoder and
 * RFC 8032 Ed25519 signature verifier without any network or Node-only dependencies.
 */

import { hexToBytes } from "./contracts";
import { BincodeReader, KovanicaDecodeError } from "./decoders";
import {
  type DecodedSignedTransferTransaction,
  TRANSFER_TX_VARIANT,
  decodeSignedTransferTransaction,
  verifyTransferTransactionSignature,
} from "./transfer-tx";
import {
  type DecodedSignedCallTransaction,
  decodeSignedCallTransaction,
  verifyCallTransactionSignature,
} from "./tx-decode";

const TX_VARIANT_OFFSET = 40;
const CALL_TX_VARIANT = 6 as const;

export type DecodedSignedTransactionAuto =
  | {
      kind: "transfer";
      variant: 0;
      tx: DecodedSignedTransferTransaction;
    }
  | {
      kind: "call";
      variant: 6;
      tx: DecodedSignedCallTransaction;
    };

export interface DecodeSignedTransactionAutoOptions {
  /**
   * Chain ID used when recomputing the domain-tagged BLAKE3 signing hash.
   * Defaults to `CHAIN_IDS.MAINNET` (`1`).
   */
  chainId?: bigint | number;
}

// --- Internal Helpers ---

function normalizeRawTxBytes(rawTx: string | Uint8Array, context: string): Uint8Array {
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
      throw new KovanicaDecodeError("INVALID_INPUT", `${context}: invalid hex string`);
    }
    return hexToBytes(hex);
  }
  throw new KovanicaDecodeError(
    "INVALID_INPUT",
    `${context}: expected Uint8Array or hex string`,
  );
}

// --- Variant Peeker, Auto-Decoder & Auto-Verifier ---

/**
 * Peeks the Bincode 1.x `TransactionKind` u32 little-endian variant discriminant at offset 40
 * (`sender[32] + nonce[8]`) from raw signed transaction bytes or hex.
 *
 * Fails closed with `KovanicaDecodeError` on invalid hex, non-bytes/string input, or
 * truncated payloads shorter than 44 bytes.
 */
export function peekTransactionVariant(rawTx: string | Uint8Array): number {
  const bytes = normalizeRawTxBytes(rawTx, "peekTransactionVariant");
  const reader = new BincodeReader(bytes);
  reader.readFixedBytes(32, "SignedTransaction.sender");
  reader.readU64("SignedTransaction.nonce");
  return reader.readU32("SignedTransaction.kind.variant");
}

/**
 * Automatically decodes a signed Kovanica transaction by inspecting its Bincode 1.x
 * `TransactionKind` variant discriminant and dispatching to the matching typed decoder:
 * - Variant `0` -> `decodeSignedTransferTransaction` (`kind: "transfer"`)
 * - Variant `6` -> `decodeSignedCallTransaction` (`kind: "call"`)
 *
 * Fails closed with `KovanicaDecodeError` on invalid hex, truncated bytes, unsupported
 * variants, or malformed wire payloads.
 */
export function decodeSignedTransactionAuto(
  rawTx: string | Uint8Array,
  options?: DecodeSignedTransactionAutoOptions,
): DecodedSignedTransactionAuto {
  const bytes = normalizeRawTxBytes(rawTx, "decodeSignedTransactionAuto");
  const variant = peekTransactionVariant(bytes);

  if (variant === TRANSFER_TX_VARIANT) {
    const tx = decodeSignedTransferTransaction(
      bytes,
      options?.chainId !== undefined ? { chainId: options.chainId } : undefined,
    );
    return {
      kind: "transfer",
      variant: TRANSFER_TX_VARIANT,
      tx,
    };
  }

  if (variant === CALL_TX_VARIANT) {
    let callChainId: number | undefined;
    if (options?.chainId !== undefined) {
      if (typeof options.chainId === "bigint") {
        if (options.chainId < 0n || options.chainId > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new KovanicaDecodeError(
            "INVALID_INPUT",
            `decodeSignedTransactionAuto: chainId ${options.chainId} out of safe integer range for Call transaction`,
            { field: "options.chainId" },
          );
        }
        callChainId = Number(options.chainId);
      } else {
        callChainId = options.chainId;
      }
    }

    const tx = decodeSignedCallTransaction(
      bytes,
      callChainId !== undefined ? { chainId: callChainId } : undefined,
    );
    return {
      kind: "call",
      variant: CALL_TX_VARIANT,
      tx,
    };
  }

  throw new KovanicaDecodeError(
    "INVALID_VARIANT",
    `Unsupported TransactionKind variant ${variant} at offset ${TX_VARIANT_OFFSET} (supported: ${TRANSFER_TX_VARIANT}=Transfer, ${CALL_TX_VARIANT}=Call)`,
    { offset: TX_VARIANT_OFFSET, field: "SignedTransaction.kind.variant" },
  );
}

/**
 * Verifies the 64-byte Ed25519 signature on an auto-decoded transaction by dispatching to
 * `verifyTransferTransactionSignature` or `verifyCallTransactionSignature`.
 *
 * Uses `publicKey` when supplied, otherwise verifies against `decoded.tx.senderBytes`.
 * Never throws on invalid inputs or malformed signature/key bytes; returns `false`.
 */
export function verifySignedTransactionAuto(
  decoded: DecodedSignedTransactionAuto,
  publicKey?: Uint8Array,
): boolean {
  try {
    if (!decoded || typeof decoded !== "object") {
      return false;
    }
    if (decoded.kind === "transfer") {
      return verifyTransferTransactionSignature(decoded.tx, publicKey);
    }
    if (decoded.kind === "call") {
      return verifyCallTransactionSignature(decoded.tx, publicKey);
    }
    return false;
  } catch {
    return false;
  }
}
