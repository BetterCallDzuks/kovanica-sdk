/**
 * Wave A Transaction Builders & Signers:
 * 1. Atomic Batch Transactions (`TransactionKind::Batch`, wire tag 13)
 * 2. Sponsored / Gasless Transactions (`TransactionKind::Sponsored`, wire tag 14)
 */

import { blake3 } from "@noble/hashes/blake3.js";
import {
  TX_DOMAIN,
  TX_KEY,
  asciiPad,
  bytesToHex,
  concatBytes,
  encodeBincodeString,
  signEd25519,
  u32le,
  u64le,
} from "./contracts";

export const MAX_BATCH_ACTIONS = 16;
export const SPONSOR_DOMAIN = asciiPad("KVNC/sponsor/v1", 16);

/** One action inside an atomic `Batch` transaction. */
export type BatchAction =
  | {
      kind: "transfer";
      to: Uint8Array;
      amount: bigint | number;
    }
  | {
      kind: "deploy";
      code: Uint8Array;
    }
  | {
      kind: "call";
      /** Target contract address (32 bytes). All-zeros targets the previous Deploy in the same batch. */
      contract: Uint8Array;
      value?: bigint | number;
      method: string;
      args: Uint8Array;
      gasLimit: bigint | number;
    };

/** Zero 32-byte address sentinel targeting the most recent `Deploy` in a `Batch`. */
export const PREV_DEPLOYED_CONTRACT = new Uint8Array(32);

function encodeBatchActionForSigning(action: BatchAction): Uint8Array {
  switch (action.kind) {
    case "transfer":
      if (action.to.length !== 32) {
        throw new Error(`BatchAction.transfer: expected 32-byte to, got ${action.to.length}`);
      }
      return concatBytes([Uint8Array.of(0), action.to, u64le(action.amount)]);
    case "deploy":
      if (action.code.length === 0) {
        throw new Error("BatchAction.deploy: bytecode must be non-empty");
      }
      return concatBytes([Uint8Array.of(1), u64le(action.code.length), action.code]);
    case "call":
      if (action.contract.length !== 32) {
        throw new Error(
          `BatchAction.call: expected 32-byte contract, got ${action.contract.length}`,
        );
      }
      return concatBytes([
        Uint8Array.of(2),
        action.contract,
        u64le(action.value ?? 0n),
        encodeBincodeString(action.method),
        u64le(action.args.length),
        action.args,
        u64le(action.gasLimit),
      ]);
  }
}

function encodeBatchActionForWire(action: BatchAction): Uint8Array {
  switch (action.kind) {
    case "transfer":
      return concatBytes([u32le(0), action.to, u64le(action.amount)]);
    case "deploy":
      return concatBytes([u32le(1), u64le(action.code.length), action.code]);
    case "call":
      return concatBytes([
        u32le(2),
        action.contract,
        u64le(action.value ?? 0n),
        encodeBincodeString(action.method),
        u64le(action.args.length),
        action.args,
        u64le(action.gasLimit),
      ]);
  }
}

/** Encodes `TransactionKind::Batch` for signing preimage (tag 13). */
export function signingBatchKindBytes(actions: BatchAction[]): Uint8Array {
  if (actions.length === 0 || actions.length > MAX_BATCH_ACTIONS) {
    throw new Error(`Batch must have 1..=${MAX_BATCH_ACTIONS} actions, got ${actions.length}`);
  }
  return concatBytes([
    Uint8Array.of(13),
    u64le(actions.length),
    ...actions.map(encodeBatchActionForSigning),
  ]);
}

/** Encodes `TransactionKind::Batch` for bincode wire serialization (variant index 13). */
export function wireBatchKindBytes(actions: BatchAction[]): Uint8Array {
  if (actions.length === 0 || actions.length > MAX_BATCH_ACTIONS) {
    throw new Error(`Batch must have 1..=${MAX_BATCH_ACTIONS} actions, got ${actions.length}`);
  }
  return concatBytes([
    u32le(13),
    u64le(actions.length),
    ...actions.map(encodeBatchActionForWire),
  ]);
}

/** Computes the canonical BLAKE3 keyed signing hash for an atomic `Batch` transaction. */
export function computeBatchSigningHash(params: {
  chainId: bigint | number;
  sender: Uint8Array;
  nonce: bigint | number;
  actions: BatchAction[];
  fee: bigint | number;
}): Uint8Array {
  if (params.sender.length !== 32) {
    throw new Error(`Expected 32-byte sender, got ${params.sender.length}`);
  }
  const preimage = concatBytes([
    TX_DOMAIN,
    u64le(params.chainId),
    params.sender,
    u64le(params.nonce),
    signingBatchKindBytes(params.actions),
    u64le(params.fee),
  ]);
  return blake3(preimage, { key: TX_KEY });
}

/** Signs and serializes an atomic `Batch` transaction to bincode bytes & 0x-hex. */
export function signBatchTransaction(params: {
  chainId: bigint | number;
  senderPrivateKey: Uint8Array;
  senderPublicKey: Uint8Array;
  nonce: bigint | number;
  actions: BatchAction[];
  fee: bigint | number;
}): { hash: Uint8Array; signature: Uint8Array; rawBytes: Uint8Array; rawHex: string } {
  const hash = computeBatchSigningHash({
    chainId: params.chainId,
    sender: params.senderPublicKey,
    nonce: params.nonce,
    actions: params.actions,
    fee: params.fee,
  });
  const signature = signEd25519(hash, params.senderPrivateKey);
  const rawBytes = concatBytes([
    params.senderPublicKey,
    u64le(params.nonce),
    wireBatchKindBytes(params.actions),
    u64le(params.fee),
    u64le(signature.length),
    signature,
    hash,
  ]);
  return { hash, signature, rawBytes, rawHex: `0x${bytesToHex(rawBytes)}` };
}

/**
 * Computes the domain-separated co-signing hash for a `TransactionKind::Sponsored` fee payer.
 * Matches `Transaction::sponsor_signing_hash` in `kovanica-types`.
 */
export function computeSponsorSigningHash(params: {
  chainId: bigint | number;
  txSigningHash: Uint8Array;
  feePayer: Uint8Array;
  fee: bigint | number;
}): Uint8Array {
  if (params.txSigningHash.length !== 32) {
    throw new Error(`Expected 32-byte txSigningHash, got ${params.txSigningHash.length}`);
  }
  if (params.feePayer.length !== 32) {
    throw new Error(`Expected 32-byte feePayer, got ${params.feePayer.length}`);
  }
  const preimage = concatBytes([
    SPONSOR_DOMAIN,
    u64le(params.chainId),
    params.txSigningHash,
    params.feePayer,
    u64le(params.fee),
  ]);
  return blake3(preimage, { key: TX_KEY });
}

/**
 * Wraps an inner kind (`signingInnerKind` + `wireInnerKind`) in `TransactionKind::Sponsored`
 * and produces both the sender signature and fee-payer co-signature.
 */
export function signSponsoredTransaction(params: {
  chainId: bigint | number;
  senderPrivateKey: Uint8Array;
  senderPublicKey: Uint8Array;
  feePayerPrivateKey: Uint8Array;
  feePayerPublicKey: Uint8Array;
  nonce: bigint | number;
  fee: bigint | number;
  signingInnerKind: Uint8Array;
  wireInnerKind: Uint8Array;
}): {
  hash: Uint8Array;
  senderSignature: Uint8Array;
  sponsorSignature: Uint8Array;
  rawBytes: Uint8Array;
  rawHex: string;
} {
  const sponsoredSigningKind = concatBytes([
    Uint8Array.of(14),
    params.feePayerPublicKey,
    params.signingInnerKind,
  ]);
  const preimage = concatBytes([
    TX_DOMAIN,
    u64le(params.chainId),
    params.senderPublicKey,
    u64le(params.nonce),
    sponsoredSigningKind,
    u64le(params.fee),
  ]);
  const hash = blake3(preimage, { key: TX_KEY });
  const senderSignature = signEd25519(hash, params.senderPrivateKey);
  const sponsorHash = computeSponsorSigningHash({
    chainId: params.chainId,
    txSigningHash: hash,
    feePayer: params.feePayerPublicKey,
    fee: params.fee,
  });
  const sponsorSignature = signEd25519(sponsorHash, params.feePayerPrivateKey);
  const wireKind = concatBytes([
    u32le(14),
    params.feePayerPublicKey,
    u64le(sponsorSignature.length),
    sponsorSignature,
    params.wireInnerKind,
  ]);
  const rawBytes = concatBytes([
    params.senderPublicKey,
    u64le(params.nonce),
    wireKind,
    u64le(params.fee),
    u64le(senderSignature.length),
    senderSignature,
    hash,
  ]);
  return {
    hash,
    senderSignature,
    sponsorSignature,
    rawBytes,
    rawHex: `0x${bytesToHex(rawBytes)}`,
  };
}
