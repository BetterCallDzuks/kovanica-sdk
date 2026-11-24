/**
 * Pure-TypeScript SLIP-0010 Ed25519 Hierarchical Deterministic (HD) Key Derivation & BIP-39 utilities.
 * Verified against crates/kovanica-wallet-core/src/hd.rs and Phase 1 golden vectors.
 *
 * Implements SLIP-0010 for the ed25519 curve:
 * - Master node: HMAC-SHA512 with key b"ed25519 seed"
 * - Hardened child derivation: 0x00 || ser256(k_par) || ser32(i) with i >= 0x8000_0000
 * - Non-hardened derivation is mathematically undefined for Ed25519 and strictly rejected
 * - Canonical Kovanica BIP-44 path: m/44'/3007'/<account>'/<change>'/<index>'
 */

import { hmac } from "@noble/hashes/hmac.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { ADDRESS_PREFIX, TESTNET_ADDRESS_PREFIX, encodeAddress } from "./address";
import { inspectAddress } from "./address-inspect";
import { CHAIN_IDS, getChainConfig } from "./chains";
import type { KovanicaClient } from "./client";
import {
  type CallTxKind,
  type CallTxKindInput,
  type SignedTxResult,
  signCallContractTransaction,
  signEd25519,
} from "./contracts";
import type { RequestOptions } from "./types";

/// Standard BIP-44 purpose constant for HD derivation (44).
export const BIP44_PURPOSE = 44;

/// Registered SLIP-0044 coin type for Kovanica (3007).
export const KOVANICA_COIN_TYPE = 3007;

/// Development/testing coin type (9999).
export const DEV_COIN_TYPE = 9999;

/// Legacy/retired local coin type (1337).
export const LEGACY_COIN_TYPE = 1337;

/// Hardened derivation offset (2^31 = 0x8000_0000).
export const HARDENED_OFFSET = 0x80000000;

const ED25519_KEY = new TextEncoder().encode("ed25519 seed");

export interface Slip10Node {
  key: Uint8Array;
  chainCode: Uint8Array;
}

export interface DerivedAccount {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  address: string;
  path: string;
}

export interface Bip44PathHardening {
  readonly purpose: boolean;
  readonly coinType: boolean;
  readonly account: boolean;
  readonly change: boolean;
  readonly addressIndex: boolean;
}

export interface ParsedBip44Path {
  readonly purpose: number;
  readonly coinType: number;
  readonly account: number;
  readonly change: number;
  readonly addressIndex: number;
  readonly hardened: Bip44PathHardening;
  readonly allHardened: boolean;
  readonly normalized: string;
}

export interface Bip44PathOptions {
  /**
   * Allowed SLIP-0044 coin type(s).
   * Defaults to `KOVANICA_COIN_TYPE` (`3007`).
   * Pass `null` to allow any valid coin type in `0..2147483647`.
   */
  coinType?: number | readonly number[] | null;
  /**
   * Require all five segments (including `change` and `addressIndex`) to be hardened,
   * matching Kovanica SLIP-0010 Ed25519 derivation (`m/44'/3007'/0'/0'/0'`).
   * Defaults to `false`.
   */
  requireAllHardened?: boolean;
  /**
   * Restrict `change` index to `0` (external) or `1` (internal/change).
   * Defaults to `false`.
   */
  strictChange?: boolean;
}

export interface Bip44PathValidationResult {
  readonly valid: boolean;
  readonly input: string;
  readonly parsed?: ParsedBip44Path;
  readonly error?: string;
}

export type WatchOnlyNetwork = "mainnet" | "testnet" | "devnet" | "custom";

export interface WatchOnlyAccount {
  readonly address: string;
  readonly format: "pro21-mainnet" | "pro21-testnet";
  readonly payloadHex: string;
  readonly canonicalMainnet: string;
  readonly canonicalTestnet: string;
  readonly chainId: number;
  readonly network: WatchOnlyNetwork;
  readonly readOnly: true;
  readonly isWatchOnly: true;
  readonly canSign: false;
}

const STRICT_UINT_REGEX = /^(?:0|[1-9]\d*)$/;
const MAX_BIP44_INDEX = HARDENED_OFFSET - 1;
const BIP44_LEVEL_NAMES = ["purpose", "coinType", "account", "change", "addressIndex"] as const;

interface ParsedSegment {
  value: number;
  hardened: boolean;
}

function parseBip44Segment(rawSegment: string, levelName: string): ParsedSegment {
  if (rawSegment.length === 0) {
    throw new Error(`Empty BIP-44 ${levelName} segment`);
  }
  const lastChar = rawSegment[rawSegment.length - 1];
  const hardened = lastChar === "'" || lastChar === "h" || lastChar === "H";
  const numStr = hardened ? rawSegment.slice(0, -1) : rawSegment;

  if (!STRICT_UINT_REGEX.test(numStr)) {
    throw new Error(`Invalid BIP-44 ${levelName} segment '${rawSegment}'`);
  }

  const value = Number(numStr);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_BIP44_INDEX) {
    throw new Error(
      `BIP-44 ${levelName} index '${numStr}' is out of range (must be 0..${MAX_BIP44_INDEX})`,
    );
  }

  return { value, hardened };
}

function resolveAllowedCoinTypes(
  coinTypeOption: Bip44PathOptions["coinType"],
): readonly number[] | null {
  if (coinTypeOption === undefined) {
    return [KOVANICA_COIN_TYPE];
  }
  if (coinTypeOption === null) {
    return null;
  }
  const list = typeof coinTypeOption === "number" ? [coinTypeOption] : coinTypeOption;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("BIP-44 coinType option must be a valid coin type, non-empty array, or null");
  }
  for (const ct of list) {
    if (!Number.isInteger(ct) || ct < 0 || ct > MAX_BIP44_INDEX) {
      throw new Error(
        `Invalid BIP-44 coinType option '${String(ct)}' (must be an integer in 0..${MAX_BIP44_INDEX})`,
      );
    }
  }
  return list;
}

/**
 * Parses and validates a BIP-44 derivation path (e.g. `m/44'/3007'/0'/0/0` or
 * Kovanica's all-hardened SLIP-0010 form `m/44'/3007'/0'/0'/0'`).
 *
 * Browser-safe: zero Node.js built-in dependencies.
 * Throws an `Error` if the path is malformed or violates the configured constraints.
 */
export function parseBip44Path(path: string, options: Bip44PathOptions = {}): ParsedBip44Path {
  if (typeof path !== "string") {
    throw new Error("Derivation path must be a string");
  }

  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw new Error("Derivation path must not be empty");
  }

  const allowedCoinTypes = resolveAllowedCoinTypes(options.coinType);
  const requireAllHardened = options.requireAllHardened ?? false;
  const strictChange = options.strictChange ?? false;

  const parts = trimmed.split("/");
  if (parts[0] !== "m" && parts[0] !== "M") {
    throw new Error(`BIP-44 path must start with 'm/' (got '${path}')`);
  }

  const levelParts = parts.slice(1);
  if (levelParts.length !== 5) {
    throw new Error(
      `BIP-44 path must have exactly 5 derivation levels (m/44'/coin_type'/account'/change/address_index), got ${levelParts.length}`,
    );
  }

  const parsedLevels = levelParts.map((seg, idx) =>
    parseBip44Segment(seg, BIP44_LEVEL_NAMES[idx]!),
  );
  const [purposeSeg, coinTypeSeg, accountSeg, changeSeg, addressIndexSeg] = parsedLevels as [
    ParsedSegment,
    ParsedSegment,
    ParsedSegment,
    ParsedSegment,
    ParsedSegment,
  ];

  if (!purposeSeg.hardened) {
    throw new Error(`BIP-44 purpose segment '${levelParts[0]}' must be hardened`);
  }
  if (!coinTypeSeg.hardened) {
    throw new Error(`BIP-44 coinType segment '${levelParts[1]}' must be hardened`);
  }
  if (!accountSeg.hardened) {
    throw new Error(`BIP-44 account segment '${levelParts[2]}' must be hardened`);
  }

  if (requireAllHardened) {
    if (!changeSeg.hardened) {
      throw new Error(
        `SLIP-0010 Ed25519 requires hardened change segment '${levelParts[3]}'`,
      );
    }
    if (!addressIndexSeg.hardened) {
      throw new Error(
        `SLIP-0010 Ed25519 requires hardened addressIndex segment '${levelParts[4]}'`,
      );
    }
  }

  if (purposeSeg.value !== BIP44_PURPOSE) {
    throw new Error(
      `Unsupported BIP-44 purpose ${purposeSeg.value}: expected ${BIP44_PURPOSE}`,
    );
  }

  if (allowedCoinTypes !== null && !allowedCoinTypes.includes(coinTypeSeg.value)) {
    throw new Error(
      `Unsupported BIP-44 coin type ${coinTypeSeg.value}: expected ${allowedCoinTypes.join(" or ")}`,
    );
  }

  if (strictChange && changeSeg.value !== 0 && changeSeg.value !== 1) {
    throw new Error(`Invalid BIP-44 change index ${changeSeg.value}: expected 0 or 1`);
  }

  const hardened: Bip44PathHardening = Object.freeze({
    purpose: purposeSeg.hardened,
    coinType: coinTypeSeg.hardened,
    account: accountSeg.hardened,
    change: changeSeg.hardened,
    addressIndex: addressIndexSeg.hardened,
  });

  const allHardened =
    hardened.purpose &&
    hardened.coinType &&
    hardened.account &&
    hardened.change &&
    hardened.addressIndex;

  const normalized = [
    "m",
    `${purposeSeg.value}'`,
    `${coinTypeSeg.value}'`,
    `${accountSeg.value}'`,
    `${changeSeg.value}${changeSeg.hardened ? "'" : ""}`,
    `${addressIndexSeg.value}${addressIndexSeg.hardened ? "'" : ""}`,
  ].join("/");

  return Object.freeze({
    purpose: purposeSeg.value,
    coinType: coinTypeSeg.value,
    account: accountSeg.value,
    change: changeSeg.value,
    addressIndex: addressIndexSeg.value,
    hardened,
    allHardened,
    normalized,
  });
}

/**
 * Validates a BIP-44 derivation path without throwing.
 * Returns `{ valid: true, input, parsed }` on success or `{ valid: false, input, error }` on failure.
 *
 * Browser-safe: zero Node.js built-in dependencies.
 */
export function validateBip44Path(
  path: string,
  options: Bip44PathOptions = {},
): Bip44PathValidationResult {
  const input = typeof path === "string" ? path : String(path);
  try {
    const parsed = parseBip44Path(path, options);
    return {
      valid: true,
      input,
      parsed,
    };
  } catch (err) {
    return {
      valid: false,
      input,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function resolveWatchOnlyNetwork(chainId: number): WatchOnlyNetwork {
  const config = getChainConfig(chainId);
  if (!config) {
    return "custom";
  }
  if (chainId === CHAIN_IDS.MAINNET) return "mainnet";
  if (chainId === CHAIN_IDS.TESTNET) return "testnet";
  if (chainId === CHAIN_IDS.DEVNET) return "devnet";
  return "custom";
}

/**
 * Creates a frozen, immutable watch-only account for a Kovanica PRO-21 address.
 * Validates the address and optional chain ID compatibility via `inspectAddress`
 * and guarantees zero private key material is stored on the returned object.
 *
 * Browser-safe: zero Node.js built-in dependencies.
 */
export function createWatchOnlyAccount(address: string, chainId?: number): WatchOnlyAccount {
  const inspection = inspectAddress(address, chainId);
  if (!inspection.valid) {
    throw new Error(inspection.error ?? "Invalid Kovanica address");
  }

  if (inspection.format !== "pro21-mainnet" && inspection.format !== "pro21-testnet") {
    throw new Error(
      `Watch-only accounts require a canonical PRO-21 address (${ADDRESS_PREFIX}...dag or ${TESTNET_ADDRESS_PREFIX}...dag), got ${inspection.format}`,
    );
  }

  const resolvedChainId =
    chainId !== undefined
      ? chainId
      : inspection.format === "pro21-testnet"
        ? CHAIN_IDS.TESTNET
        : CHAIN_IDS.MAINNET;

  const normalizedAddress =
    inspection.format === "pro21-testnet"
      ? inspection.canonicalTestnet!
      : inspection.canonicalMainnet!;

  return Object.freeze({
    address: normalizedAddress,
    format: inspection.format,
    payloadHex: inspection.payloadHex!,
    canonicalMainnet: inspection.canonicalMainnet!,
    canonicalTestnet: inspection.canonicalTestnet!,
    chainId: resolvedChainId,
    network: resolveWatchOnlyNetwork(resolvedChainId),
    readOnly: true as const,
    isWatchOnly: true as const,
    canSign: false as const,
  });
}

/**
 * Safely wipe sensitive byte arrays in-memory.
 */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}

/**
 * Derive BIP-39 64-byte binary seed from mnemonic phrase and optional passphrase.
 */
export function bip39Seed(phrase: string, passphrase = ""): Uint8Array {
  const normPhrase = phrase.normalize("NFKD").trim().replace(/\s+/g, " ");
  const normPass = ("mnemonic" + passphrase).normalize("NFKD");
  return pbkdf2(
    sha512,
    new TextEncoder().encode(normPhrase),
    new TextEncoder().encode(normPass),
    { c: 2048, dkLen: 64 },
  );
}

/**
 * Derive the SLIP-0010 master node from a 16..64 byte binary seed (typically 64-byte BIP-39 seed).
 */
export function masterFromSeed(seed: Uint8Array): Slip10Node {
  if (seed.length < 16 || seed.length > 64) {
    throw new Error(
      `Invalid seed length ${seed.length}: SLIP-0010 seed must be between 16 and 64 bytes`,
    );
  }
  const digest = hmac(sha512, ED25519_KEY, seed);
  return {
    key: digest.slice(0, 32),
    chainCode: digest.slice(32, 64),
  };
}

/**
 * Derive a hardened child key at index `i >= 0x8000_0000`.
 *
 * Non-hardened derivation (`i < 0x8000_0000`) is not defined for Ed25519 in SLIP-0010
 * and is strictly rejected.
 */
export function deriveHardened(parent: Slip10Node, index: number): Slip10Node {
  if (!Number.isInteger(index) || index < HARDENED_OFFSET || index > 0xffffffff) {
    throw new Error(
      `SLIP-0010 Ed25519 does not support non-hardened child derivation: index ${index} < 0x80000000`,
    );
  }

  const data = new Uint8Array(37);
  data[0] = 0x00;
  data.set(parent.key, 1);
  new DataView(data.buffer).setUint32(33, index, false);

  const digest = hmac(sha512, parent.chainCode, data);
  wipe(data);

  return {
    key: digest.slice(0, 32),
    chainCode: digest.slice(32, 64),
  };
}

/**
 * Derive a child node along a string path such as `m/44'/3007'/0'/0'/0'`.
 * Every segment must be hardened (ending with `'` or `h` or `H`).
 */
export function derivePath(master: Slip10Node, path: string): Slip10Node {
  const trimmed = path.trim();
  const segments = trimmed.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new Error("Empty derivation path");
  }

  let startIdx = 0;
  if (segments[0] === "m" || segments[0] === "M") {
    startIdx = 1;
  }

  let current: Slip10Node = {
    key: new Uint8Array(master.key),
    chainCode: new Uint8Array(master.chainCode),
  };

  for (let i = startIdx; i < segments.length; i++) {
    const seg = segments[i];
    const isHardened = seg.endsWith("'") || seg.endsWith("h") || seg.endsWith("H");
    if (!isHardened) {
      throw new Error(
        `SLIP-0010 Ed25519 strictly requires hardened path segments: '${seg}' is not hardened`,
      );
    }
    const numStr = seg.slice(0, -1);
    const rawIdx = Number.parseInt(numStr, 10);
    if (!Number.isInteger(rawIdx) || rawIdx < 0) {
      throw new Error(`Invalid segment index '${numStr}'`);
    }
    if (rawIdx >= HARDENED_OFFSET) {
      throw new Error(`Segment index '${rawIdx}' already exceeds hardened offset`);
    }
    const hardenedIdx = rawIdx + HARDENED_OFFSET;
    const next = deriveHardened(current, hardenedIdx);
    wipe(current.key);
    wipe(current.chainCode);
    current = next;
  }

  return current;
}

/**
 * Formats a canonical Kovanica BIP-44 path.
 */
export function formatBip44Path(
  account = 0,
  change = 0,
  index = 0,
  coinType = KOVANICA_COIN_TYPE,
): string {
  return `m/${BIP44_PURPOSE}'/${coinType}'/${account}'/${change}'/${index}'`;
}

/**
 * Derives standard Kovanica BIP-44 child node `m/44'/<coinType>'/<account>'/<change>'/<index>'`.
 */
export function deriveBip44(
  seed64: Uint8Array,
  account = 0,
  change = 0,
  index = 0,
  coinType = KOVANICA_COIN_TYPE,
): Slip10Node {
  for (const step of [account, change, index]) {
    if (!Number.isInteger(step) || step < 0 || step >= HARDENED_OFFSET) {
      throw new Error(
        `account, change, and index must be unhardened indices (< 0x8000_0000), got ${step}`,
      );
    }
  }

  let node = masterFromSeed(seed64);
  const steps = [BIP44_PURPOSE, coinType, account, change, index];

  for (const step of steps) {
    const next = deriveHardened(node, step + HARDENED_OFFSET);
    wipe(node.key);
    wipe(node.chainCode);
    node = next;
  }

  return node;
}

// --- Pure JS Ed25519 Curve Math for Point Multiplication ---

const P = 2n ** 255n - 19n;
const d = (-121665n * modInverse(121666n, P)) % P;
const d_mod = (d + P) % P;
const I = modPow(2n, (P - 1n) / 4n, P);

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

function recoverX(y: bigint): bigint {
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (d_mod * y2 + 1n) % P;
  let x = (u * modInverse(v, P)) % P;
  x = modPow(x, (P + 3n) / 8n, P);
  if ((x * x - u * modInverse(v, P)) % P !== 0n) {
    x = (x * I) % P;
  }
  if (x % 2n !== 0n) x = P - x;
  return x;
}

const By = (4n * modInverse(5n, P)) % P;
const Bx = recoverX(By);
type ExtendedPoint = [bigint, bigint, bigint, bigint];
const B: ExtendedPoint = [Bx, By, 1n, (Bx * By) % P];

function pointAdd(p1: ExtendedPoint, p2: ExtendedPoint): ExtendedPoint {
  const [X1, Y1, Z1, T1] = p1;
  const [X2, Y2, Z2, T2] = p2;
  const A = ((Y1 - X1 + P) * (Y2 - X2 + P)) % P;
  const B_coord = ((Y1 + X1) * (Y2 + X2)) % P;
  const C = (2n * T1 * T2 * d_mod) % P;
  const D = (2n * Z1 * Z2) % P;
  const E = (B_coord - A + P) % P;
  const F = (D - C + P) % P;
  const G = (D + C) % P;
  const H = (B_coord + A) % P;
  return [(E * F) % P, (G * H) % P, (F * G) % P, (E * H) % P];
}

function pointDouble(p: ExtendedPoint): ExtendedPoint {
  const [X1, Y1, Z1] = p;
  const A = (X1 * X1) % P;
  const B_coord = (Y1 * Y1) % P;
  const C = (2n * Z1 * Z1) % P;
  const D = (P - A) % P;
  const E = ((X1 + Y1) * (X1 + Y1) - A - B_coord + 2n * P) % P;
  const G = (D + B_coord) % P;
  const F = (G - C + P) % P;
  const H = (D - B_coord + P) % P;
  return [(E * F) % P, (G * H) % P, (F * G) % P, (E * H) % P];
}

function scalarMult(k: bigint, pt: ExtendedPoint): ExtendedPoint {
  let r: ExtendedPoint = [0n, 1n, 1n, 0n];
  let base = pt;
  while (k > 0n) {
    if (k & 1n) r = pointAdd(r, base);
    base = pointDouble(base);
    k >>= 1n;
  }
  return r;
}

/**
 * Computes the 32-byte Ed25519 public key from a 32-byte secret key seed.
 * Conforms to RFC 8032 and matches kovanica-types / kovanica-wallet-core.
 */
export function getPublicKey(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== 32) {
    throw new Error(`Secret key must be 32 bytes, got ${secretKey.length}`);
  }
  const hash = sha512(secretKey);
  const clamped = new Uint8Array(hash.slice(0, 32));
  clamped[0] &= 248;
  clamped[31] &= 127;
  clamped[31] |= 64;

  let scalar = 0n;
  for (let i = 0; i < 32; i++) {
    scalar |= BigInt(clamped[i]!) << BigInt(8 * i);
  }

  const [X, Y, Z] = scalarMult(scalar, B);
  const zInv = modInverse(Z, P);
  const x = (X * zInv) % P;
  const y = (Y * zInv) % P;

  const pub = new Uint8Array(32);
  let tempY = y;
  for (let i = 0; i < 32; i++) {
    pub[i] = Number(tempY & 0xffn);
    tempY >>= 8n;
  }
  if (x & 1n) {
    pub[31]! |= 0x80;
  }

  wipe(clamped);
  return pub;
}

/**
 * Convenience helper to derive a complete account from a 64-byte seed.
 */
export function addressFromSeed(
  seed64: Uint8Array,
  account = 0,
  change = 0,
  index = 0,
  coinType = KOVANICA_COIN_TYPE,
  prefix = ADDRESS_PREFIX,
): DerivedAccount {
  const node = deriveBip44(seed64, account, change, index, coinType);
  const pub = getPublicKey(node.key);
  const address = encodeAddress(pub, prefix);
  const path = formatBip44Path(account, change, index, coinType);
  wipe(node.chainCode);
  return {
    secretKey: node.key,
    publicKey: pub,
    address,
    path,
  };
}

/**
 * High-level wallet representation for key management, transaction signing, and contract interactions.
 */
export class KovanicaWallet {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly address: string;
  readonly chainId: number;
  readonly client?: KovanicaClient;

  constructor(
    secretKey: Uint8Array,
    options: { chainId?: number; client?: KovanicaClient } = {},
  ) {
    if (secretKey.length !== 32) {
      throw new Error(`Secret key must be 32 bytes, got ${secretKey.length}`);
    }
    this.secretKey = new Uint8Array(secretKey);
    this.publicKey = getPublicKey(this.secretKey);
    this.chainId = options.chainId ?? CHAIN_IDS.MAINNET;
    this.address = encodeAddress(
      this.publicKey,
      this.chainId === CHAIN_IDS.TESTNET ? TESTNET_ADDRESS_PREFIX : ADDRESS_PREFIX,
    );
    this.client = options.client;
  }

  static fromSeed(
    seed64: Uint8Array,
    account = 0,
    change = 0,
    index = 0,
    coinType = KOVANICA_COIN_TYPE,
    options: { chainId?: number; client?: KovanicaClient } = {},
  ): KovanicaWallet {
    const node = deriveBip44(seed64, account, change, index, coinType);
    const wallet = new KovanicaWallet(node.key, options);
    wipe(node.chainCode);
    return wallet;
  }

  static fromMnemonic(
    mnemonic: string,
    passphrase = "",
    account = 0,
    change = 0,
    index = 0,
    coinType = KOVANICA_COIN_TYPE,
    options: { chainId?: number; client?: KovanicaClient } = {},
  ): KovanicaWallet {
    const seed = bip39Seed(mnemonic, passphrase);
    const wallet = KovanicaWallet.fromSeed(seed, account, change, index, coinType, options);
    wipe(seed);
    return wallet;
  }

  /**
   * Signs an arbitrary byte message using pure Ed25519 (RFC 8032).
   */
  sign(message: Uint8Array): Uint8Array {
    return signEd25519(message, this.secretKey);
  }

  /**
   * Constructs and signs a Call contract transaction.
   */
  signCallTransaction(
    call: CallTxKind | CallTxKindInput,
    options: { nonce: bigint | number; fee: bigint | number; chainId?: number },
  ): SignedTxResult {
    return signCallContractTransaction({
      sender: this.publicKey,
      secretKey: this.secretKey,
      call,
      nonce: options.nonce,
      fee: options.fee,
      chainId: options.chainId ?? this.chainId,
    });
  }

  /**
   * Constructs, signs, and broadcasts a Call contract transaction using the attached client.
   */
  async sendCallTransaction(
    call: CallTxKind | CallTxKindInput,
    options: {
      nonce?: bigint | number;
      fee?: bigint | number;
      chainId?: number;
      requestOptions?: RequestOptions;
    } = {},
  ): Promise<string> {
    if (!this.client) {
      throw new Error("Cannot send transaction: no KovanicaClient attached to KovanicaWallet");
    }
    const nonce = options.nonce ?? (await this.client.getNonce(this.address, options.requestOptions));
    const fee = options.fee ?? (await this.client.estimateFee(options.requestOptions));
    const signed = this.signCallTransaction(call, {
      nonce,
      fee,
      chainId: options.chainId ?? this.chainId,
    });
    return this.client.sendRawTransaction(`0x${signed.rawTxHex}`, options.requestOptions);
  }
}
