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
import { ADDRESS_PREFIX, encodeAddress } from "./address";

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
