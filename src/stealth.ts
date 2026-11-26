/**
 * KVP-103 / RFC-003 — Client-Side Dual-Key Stealth Addresses on Ed25519.
 *
 * Works natively on Kovanica L1 (Mainnet & Testnet) with zero consensus changes:
 * every derived one-time address is a standard Ed25519 Kovanica account
 * (`kvnc…dag` / `tknc…dag`), and spends sign standard L1 sighashes with the
 * derived one-time scalar (`p = (b + t) mod L`) using RFC 8032 Ed25519 verification.
 *
 * Wire-compatible and cryptographically bit-for-bit identical to
 * `kovanica-web/src/lib/protocol/stealth.ts`.
 *
 * Privacy invariants:
 * - Scan private key (`v`) and spend private key (`b`) NEVER leave the client.
 * - Watch-only scanning uses ONLY `(v, B)` — `b` is never needed until spending.
 * - Announcements contain only public data `(R, viewTag, stealthAddress)`.
 * - Browser-safe: zero Node.js built-in dependencies.
 */

import { blake3 } from "@noble/hashes/blake3.js";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  ADDRESS_LEN,
  ADDRESS_PREFIX,
  ADDRESS_SUFFIX,
  TESTNET_ADDRESS_PREFIX,
  decodeAddress,
  encodeAddress,
  parseLegacyAddress,
} from "./address";
import { bytesToHex, concatBytes, hexToBytes } from "./contracts";

// --- Protocol Constants & Domain Separators -----------------------------------

export const STEALTH_META_ADDRESS_PREFIX = "st:kvnc:";
export const STEALTH_DOMAIN_TWEAK = "KVNC/stealth/tweak/v1";
export const STEALTH_DOMAIN_TAG = "KVNC/stealth/tag/v1";
export const STEALTH_DOMAIN_NONCE = "KVNC/stealth/nonce/v1";
export const STEALTH_DOMAIN_SCAN_KEY = "KVNC/stealth/scan/v1";
export const STEALTH_DOMAIN_SPEND_KEY = "KVNC/stealth/spend/v1";

const TEXT_ENCODER = new TextEncoder();
const DOMAIN_TWEAK = TEXT_ENCODER.encode(STEALTH_DOMAIN_TWEAK);
const DOMAIN_TAG = TEXT_ENCODER.encode(STEALTH_DOMAIN_TAG);
const DOMAIN_NONCE = TEXT_ENCODER.encode(STEALTH_DOMAIN_NONCE);
const DOMAIN_SCAN_KEY = TEXT_ENCODER.encode(STEALTH_DOMAIN_SCAN_KEY);
const DOMAIN_SPEND_KEY = TEXT_ENCODER.encode(STEALTH_DOMAIN_SPEND_KEY);

// --- Public Types -------------------------------------------------------------

export interface StealthKeypair {
  scanPrivkeyHex: string;
  scanPubkeyHex: string;
  spendPrivkeyHex: string;
  spendPubkeyHex: string;
  metaAddress: string;
}

export interface StealthMetaAddress {
  scanPubkeyHex: string;
  spendPubkeyHex: string;
  metaAddress: string;
}

export interface StealthOnetime {
  /** Canonical `kvnc…dag` (or configured prefix) one-time L1 address. */
  address: string;
  /** 64-char lowercase hex Ed25519 public key of the one-time L1 address. */
  addressHex: string;
  /** 64-char lowercase hex ephemeral public key `R = r·G` published by the sender. */
  ephemeralPubkeyHex: string;
  /** 4-char lowercase hex (2-byte) fast-filter view tag. */
  viewTag: string;
}

export interface DeriveOnetimeAddressOptions {
  /** Optional deterministic ephemeral scalar override (testing / deterministic vectors). */
  ephemeralScalar?: bigint;
  /** Address prefix for the derived PRO-21 address (defaults to `kvnc`). */
  addressPrefix?: string;
}

export interface StealthAnnouncementInput {
  ephemeralPubkeyHex: string;
  viewTag?: string;
  stealthAddress?: string;
  stealthAddressHex?: string;
  txHash?: string;
  createdAt?: string;
}

export type StealthAnnouncementMatch =
  | {
      matched: true;
      address: string;
      addressHex: string;
      viewTag: string;
    }
  | {
      matched: false;
    };

export interface StealthMatchedAnnouncement {
  address: string;
  addressHex: string;
  ephemeralPubkeyHex: string;
  viewTag: string;
  txHash?: string;
  createdAt?: string;
}

export interface ScanStealthAnnouncementsParams {
  scanPrivkeyHex: string;
  spendPubkeyHex: string;
  announcements: readonly StealthAnnouncementInput[];
  /** Address prefix for matched PRO-21 addresses (defaults to `kvnc`). */
  addressPrefix?: string;
}

export interface DeriveOnetimeSpendKeyParams {
  scanPrivkeyHex: string;
  spendPrivkeyHex: string;
  ephemeralPubkeyHex: string;
  /** Address prefix for the recovered PRO-21 address (defaults to `kvnc`). */
  addressPrefix?: string;
}

export interface StealthSpendKey {
  oneTimeScalarHex: string;
  address: string;
  addressHex: string;
  viewTag: string;
}

export interface StealthSignature {
  signatureHex: string;
  publicKeyHex: string;
}

// --- Pure-TypeScript Ed25519 Curve Arithmetic ---------------------------------

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

function isIdentity(pt: ExtendedPoint): boolean {
  const [X, Y, Z] = pt;
  return mod(X, ED_P) === 0n && mod(Y - Z, ED_P) === 0n;
}

function isSmallOrder(pt: ExtendedPoint): boolean {
  // Cofactor of Ed25519 is 8; small-order points satisfy 8 * P == O.
  const p8 = pointDouble(pointDouble(pointDouble(pt)));
  return isIdentity(p8);
}

function decodePoint(bytes: Uint8Array): ExtendedPoint | null {
  if (bytes.length !== 32) return null;

  const signBit = (bytes[31]! & 0x80) !== 0 ? 1n : 0n;
  let y = 0n;
  for (let i = 0; i < 31; i += 1) {
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

function pointToBytes(pt: ExtendedPoint): Uint8Array {
  const [X, Y, Z] = pt;
  const zInv = modInverse(Z, ED_P);
  const x = mod(X * zInv, ED_P);
  const y = mod(Y * zInv, ED_P);

  const out = new Uint8Array(32);
  let tempY = y;
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(tempY & 0xffn);
    tempY >>= 8n;
  }
  if ((x & 1n) !== 0n) {
    out[31]! |= 0x80;
  }
  return out;
}

function pointToHex(pt: ExtendedPoint): string {
  return bytesToHex(pointToBytes(pt));
}

// --- Low-level Byte & Scalar Helpers ------------------------------------------

function bytesToBigintLE(bytes: Uint8Array): bigint {
  let acc = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    acc = (acc << 8n) | BigInt(bytes[i]!);
  }
  return acc;
}

function bigintToBytes32LE(n: bigint): Uint8Array {
  let v = mod(n, ED_L);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function reduceScalarModL(bytes: Uint8Array): bigint {
  const s = bytesToBigintLE(bytes) % ED_L;
  return s === 0n ? 1n : s;
}

function parseScalarHex(hex: string, label: string): bigint {
  const clean = hex.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error(`${label} must be 64 hex characters (32 bytes)`);
  }
  const s = bytesToBigintLE(hexToBytes(clean)) % ED_L;
  if (s === 0n) {
    throw new Error(`${label} scalar cannot be zero`);
  }
  return s;
}

function parseValidPoint(hex: string, label: string): ExtendedPoint {
  const clean = hex.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error(`${label} must be a 64-char hex Ed25519 public key`);
  }
  const pt = decodePoint(hexToBytes(clean));
  if (!pt || isIdentity(pt) || isSmallOrder(pt)) {
    throw new Error(`${label} is an invalid or small-order curve point`);
  }
  return pt;
}

interface NodeProcessLike {
  versions?: { node?: string };
  getBuiltinModule?: (id: string) => unknown;
}

interface NodeCryptoLike {
  randomBytes?: (size: number) => Uint8Array;
  webcrypto?: {
    getRandomValues: <T extends ArrayBufferView>(array: T) => T;
  };
}

function getNodeProcess(): NodeProcessLike | undefined {
  return (globalThis as unknown as { process?: NodeProcessLike }).process;
}

let cachedNodeCrypto: NodeCryptoLike | null = null;

// Pre-load `node:crypto` on Node 18 runtimes where `globalThis.crypto` is not exposed globally.
// Uses a computed specifier so browser bundlers do not statically resolve `node:crypto`.
const nodeProcessAtLoad = getNodeProcess();
if (
  typeof globalThis.crypto?.getRandomValues !== "function" &&
  typeof nodeProcessAtLoad?.versions?.node === "string"
) {
  const nodeCryptoSpecifier = `node:${"crypto"}`;
  void import(/* @vite-ignore */ nodeCryptoSpecifier)
    .then((mod: unknown) => {
      if (mod && typeof mod === "object") {
        cachedNodeCrypto = mod as NodeCryptoLike;
      }
    })
    .catch(() => {
      // Ignore; randomBytes() will fall back to synchronous loaders or throw cleanly.
    });
}

function getNodeCryptoSync(): NodeCryptoLike | null {
  if (cachedNodeCrypto) {
    return cachedNodeCrypto;
  }
  const proc = getNodeProcess();
  if (typeof proc?.getBuiltinModule === "function") {
    const mod = proc.getBuiltinModule(`node:${"crypto"}`);
    if (mod && typeof mod === "object") {
      cachedNodeCrypto = mod as NodeCryptoLike;
      return cachedNodeCrypto;
    }
  }
  try {
    const dynamicRequire = Function(
      "return typeof require === 'function' ? require : null;",
    )() as ((id: string) => unknown) | null;
    if (dynamicRequire) {
      const mod = dynamicRequire(`node:${"crypto"}`);
      if (mod && typeof mod === "object") {
        cachedNodeCrypto = mod as NodeCryptoLike;
        return cachedNodeCrypto;
      }
    }
  } catch {
    // Not in a CommonJS environment.
  }
  return null;
}

function randomBytes(length: number): Uint8Array {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    const out = new Uint8Array(length);
    cryptoObj.getRandomValues(out);
    return out;
  }

  const nodeCrypto = getNodeCryptoSync();
  if (nodeCrypto?.webcrypto && typeof nodeCrypto.webcrypto.getRandomValues === "function") {
    const out = new Uint8Array(length);
    nodeCrypto.webcrypto.getRandomValues(out);
    return out;
  }
  if (typeof nodeCrypto?.randomBytes === "function") {
    const buf = nodeCrypto.randomBytes(length);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  throw new Error(
    "Web Crypto API (crypto.getRandomValues) is unavailable in this runtime",
  );
}

function randomScalar(): bigint {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const rnd = randomBytes(64);
    const s = bytesToBigintLE(rnd) % ED_L;
    if (s !== 0n) return s;
  }
  throw new Error("Failed to sample non-zero Ed25519 scalar");
}

function sharedSecretTweakAndTag(sharedPointBytes: Uint8Array): {
  tweak: bigint;
  viewTag: string;
} {
  const tweakDigest = blake3(concatBytes([DOMAIN_TWEAK, sharedPointBytes]));
  const tagDigest = blake3(concatBytes([DOMAIN_TAG, sharedPointBytes]));
  return {
    tweak: reduceScalarModL(tweakDigest),
    viewTag: bytesToHex(tagDigest.subarray(0, 2)),
  };
}

function parseStealthAddressToHex(address: string): string | null {
  const trimmed = address.trim();
  try {
    if (
      trimmed.length === ADDRESS_LEN &&
      (trimmed.startsWith(ADDRESS_PREFIX) || trimmed.startsWith(TESTNET_ADDRESS_PREFIX)) &&
      trimmed.endsWith(ADDRESS_SUFFIX)
    ) {
      return bytesToHex(decodeAddress(trimmed));
    }
    return bytesToHex(parseLegacyAddress(trimmed));
  } catch {
    return null;
  }
}

// --- Meta-Address & Keypair Helpers -------------------------------------------

/**
 * Formats a validated KVP-103 stealth meta-address:
 * `st:kvnc:<64-hex-scan-pubkey>:<64-hex-spend-pubkey>`.
 */
export function formatStealthMetaAddress(scanPubkeyHex: string, spendPubkeyHex: string): string {
  const scan = pointToHex(parseValidPoint(scanPubkeyHex, "Scan pubkey"));
  const spend = pointToHex(parseValidPoint(spendPubkeyHex, "Spend pubkey"));
  return `${STEALTH_META_ADDRESS_PREFIX}${scan}:${spend}`;
}

/**
 * Parses and cryptographically validates a KVP-103 stealth meta-address.
 * Rejects malformed strings, non-canonical encodings, identity, and small-order points.
 */
export function parseStealthMetaAddress(metaAddress: string): StealthMetaAddress {
  const trimmed = metaAddress.trim();
  const match = /^st:kvnc:([0-9a-fA-F]{64}):([0-9a-fA-F]{64})$/.exec(trimmed);
  if (!match) {
    throw new Error(
      "Invalid stealth meta-address: expected st:kvnc:<64-hex-scan>:<64-hex-spend>",
    );
  }
  const scanPubkeyHex = pointToHex(parseValidPoint(match[1]!, "Scan pubkey"));
  const spendPubkeyHex = pointToHex(parseValidPoint(match[2]!, "Spend pubkey"));
  return {
    scanPubkeyHex,
    spendPubkeyHex,
    metaAddress: `${STEALTH_META_ADDRESS_PREFIX}${scanPubkeyHex}:${spendPubkeyHex}`,
  };
}

/** Construct a validated stealth meta-address from scan and spend public keys. */
export function createStealthMeta(
  scanPubkeyHex: string,
  spendPubkeyHex: string,
): StealthMetaAddress {
  const metaAddress = formatStealthMetaAddress(scanPubkeyHex, spendPubkeyHex);
  return parseStealthMetaAddress(metaAddress);
}

/** Returns `true` if `metaAddress` is a valid KVP-103 stealth meta-address. */
export function isValidStealthMetaAddress(metaAddress: string): boolean {
  try {
    parseStealthMetaAddress(metaAddress);
    return true;
  } catch {
    return false;
  }
}

/** Generate a fresh random KVP-103 dual-key stealth keypair locally on the client. */
export function generateStealthKeypair(): StealthKeypair {
  const scanScalar = randomScalar();
  const spendScalar = randomScalar();
  const scanPubkeyHex = pointToHex(scalarMult(scanScalar, ED_B));
  const spendPubkeyHex = pointToHex(scalarMult(spendScalar, ED_B));
  return {
    scanPrivkeyHex: bytesToHex(bigintToBytes32LE(scanScalar)),
    scanPubkeyHex,
    spendPrivkeyHex: bytesToHex(bigintToBytes32LE(spendScalar)),
    spendPubkeyHex,
    metaAddress: `${STEALTH_META_ADDRESS_PREFIX}${scanPubkeyHex}:${spendPubkeyHex}`,
  };
}

/**
 * Deterministically derive KVP-103 stealth keys from a wallet mnemonic so
 * users can recover their stealth identity from their backup phrase.
 */
export function deriveStealthKeypairFromMnemonic(mnemonic: string): StealthKeypair {
  const norm = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
  if (norm.split(" ").length < 12) {
    throw new Error("Mnemonic must contain at least 12 words");
  }
  const phraseBytes = TEXT_ENCODER.encode(norm);
  const scanScalar = reduceScalarModL(blake3(concatBytes([DOMAIN_SCAN_KEY, phraseBytes])));
  const spendScalar = reduceScalarModL(blake3(concatBytes([DOMAIN_SPEND_KEY, phraseBytes])));
  const scanPubkeyHex = pointToHex(scalarMult(scanScalar, ED_B));
  const spendPubkeyHex = pointToHex(scalarMult(spendScalar, ED_B));
  return {
    scanPrivkeyHex: bytesToHex(bigintToBytes32LE(scanScalar)),
    scanPubkeyHex,
    spendPrivkeyHex: bytesToHex(bigintToBytes32LE(spendScalar)),
    spendPubkeyHex,
    metaAddress: `${STEALTH_META_ADDRESS_PREFIX}${scanPubkeyHex}:${spendPubkeyHex}`,
  };
}

// --- Sender: One-Time Stealth Address Derivation ------------------------------

/**
 * Derive a fresh, unlinkable one-time L1 address (`kvnc…dag`) for a recipient's
 * `st:kvnc:<scanPub>:<spendPub>` meta-address. Runs 100% client-side.
 *
 * Accepts either a `bigint` ephemeral scalar override (matching `kovanica-web`)
 * or a `DeriveOnetimeAddressOptions` object.
 */
export function deriveOnetimeAddress(
  metaAddress: string,
  optionsOrEphemeralScalar?: bigint | DeriveOnetimeAddressOptions,
): StealthOnetime {
  const { scanPubkeyHex, spendPubkeyHex } = parseStealthMetaAddress(metaAddress);
  const V = parseValidPoint(scanPubkeyHex, "Scan pubkey");
  const B = parseValidPoint(spendPubkeyHex, "Spend pubkey");

  const options: DeriveOnetimeAddressOptions =
    typeof optionsOrEphemeralScalar === "bigint"
      ? { ephemeralScalar: optionsOrEphemeralScalar }
      : (optionsOrEphemeralScalar ?? {});

  let r: bigint;
  if (options.ephemeralScalar !== undefined) {
    r = mod(options.ephemeralScalar, ED_L);
    if (r === 0n) {
      throw new Error("Ephemeral scalar cannot be zero");
    }
  } else {
    r = randomScalar();
  }

  const R = scalarMult(r, ED_B);
  const shared = pointToBytes(scalarMult(r, V));
  const { tweak, viewTag } = sharedSecretTweakAndTag(shared);

  const P = pointAdd(B, scalarMult(tweak, ED_B));
  const pubBytes = pointToBytes(P);
  const prefix = options.addressPrefix ?? ADDRESS_PREFIX;
  return {
    address: encodeAddress(pubBytes, prefix),
    addressHex: bytesToHex(pubBytes),
    ephemeralPubkeyHex: pointToHex(R),
    viewTag,
  };
}

// --- Recipient: Client-Side ECDH Scanning -------------------------------------

/**
 * Test a single public announcement `(R, viewTag, stealthAddress)` locally using
 * ONLY `(scanPrivkeyHex, spendPubkeyHex)`. Never requires the spend private key.
 */
export function matchStealthAnnouncement(
  scanPrivkeyHex: string,
  spendPubkeyHex: string,
  announcement: StealthAnnouncementInput,
  options?: { addressPrefix?: string },
): StealthAnnouncementMatch {
  const v = parseScalarHex(scanPrivkeyHex, "Scan private key");
  const B = parseValidPoint(spendPubkeyHex, "Spend public key");

  let R: ExtendedPoint;
  try {
    R = parseValidPoint(announcement.ephemeralPubkeyHex, "Ephemeral pubkey");
  } catch {
    return { matched: false };
  }

  const shared = pointToBytes(scalarMult(v, R));
  const { tweak, viewTag } = sharedSecretTweakAndTag(shared);

  if (announcement.viewTag && announcement.viewTag.trim().toLowerCase() !== viewTag) {
    return { matched: false };
  }

  const P = pointAdd(B, scalarMult(tweak, ED_B));
  const derivedBytes = pointToBytes(P);
  const derivedHex = bytesToHex(derivedBytes);

  if (announcement.stealthAddressHex !== undefined) {
    const expectedHex = announcement.stealthAddressHex.trim().replace(/^0x/i, "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedHex) || expectedHex !== derivedHex) {
      return { matched: false };
    }
  } else if (announcement.stealthAddress !== undefined) {
    const expectedHex = parseStealthAddressToHex(announcement.stealthAddress);
    if (!expectedHex || expectedHex !== derivedHex) {
      return { matched: false };
    }
  }

  const prefix = options?.addressPrefix ?? ADDRESS_PREFIX;
  return {
    matched: true,
    address: encodeAddress(derivedBytes, prefix),
    addressHex: derivedHex,
    viewTag,
  };
}

/**
 * Batch-scan a list of public stealth announcements offline using ONLY
 * `(scanPrivkeyHex, spendPubkeyHex)` (watch-only). Deduplicates by derived
 * one-time public key hex.
 */
export function scanStealthAnnouncements(
  params: ScanStealthAnnouncementsParams,
): StealthMatchedAnnouncement[] {
  // Validate keys once up front so invalid keys throw even on empty announcement lists.
  parseScalarHex(params.scanPrivkeyHex, "Scan private key");
  parseValidPoint(params.spendPubkeyHex, "Spend public key");

  const matched: StealthMatchedAnnouncement[] = [];
  const seenAddr = new Set<string>();

  for (const candidate of params.announcements) {
    const res = matchStealthAnnouncement(
      params.scanPrivkeyHex,
      params.spendPubkeyHex,
      candidate,
      { addressPrefix: params.addressPrefix },
    );
    if (res.matched && !seenAddr.has(res.addressHex)) {
      seenAddr.add(res.addressHex);
      matched.push({
        address: res.address,
        addressHex: res.addressHex,
        ephemeralPubkeyHex: candidate.ephemeralPubkeyHex.trim().replace(/^0x/i, "").toLowerCase(),
        viewTag: res.viewTag,
        ...(candidate.txHash !== undefined ? { txHash: candidate.txHash } : {}),
        ...(candidate.createdAt !== undefined ? { createdAt: candidate.createdAt } : {}),
      });
    }
  }

  return matched;
}

// --- Recipient: One-Time Spend Key Derivation & RFC 8032 Scalar Signing -------

/**
 * Derive the one-time Ed25519 spend scalar `p = (b + t) mod L` and compute
 * its corresponding one-time L1 address.
 */
export function deriveOnetimeSpendKey(params: DeriveOnetimeSpendKeyParams): StealthSpendKey {
  const v = parseScalarHex(params.scanPrivkeyHex, "Scan private key");
  const b = parseScalarHex(params.spendPrivkeyHex, "Spend private key");
  const R = parseValidPoint(params.ephemeralPubkeyHex, "Ephemeral pubkey");

  const shared = pointToBytes(scalarMult(v, R));
  const { tweak, viewTag } = sharedSecretTweakAndTag(shared);

  const p = (b + tweak) % ED_L;
  if (p === 0n) {
    throw new Error("Derived one-time scalar is zero");
  }
  const P = scalarMult(p, ED_B);
  const pubBytes = pointToBytes(P);
  const addressHex = bytesToHex(pubBytes);
  const prefix = params.addressPrefix ?? ADDRESS_PREFIX;

  return {
    oneTimeScalarHex: bytesToHex(bigintToBytes32LE(p)),
    address: encodeAddress(pubBytes, prefix),
    addressHex,
    viewTag,
  };
}

/**
 * Sign a 32-byte L1 transaction sighash hex directly with a derived one-time
 * Ed25519 scalar `p` (RFC 8032 compatible — verifies under standard Ed25519).
 */
export function signSighashWithStealthScalar(
  oneTimeScalarHex: string,
  sighashHex: string,
): StealthSignature {
  const p = parseScalarHex(oneTimeScalarHex, "One-time spend scalar");
  const cleanMsgHex = sighashHex.trim().replace(/^0x/i, "");
  if (cleanMsgHex.length === 0 || cleanMsgHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(cleanMsgHex)) {
    throw new Error("Invalid sighash hex string");
  }
  const msg = hexToBytes(cleanMsgHex);
  const P = scalarMult(p, ED_B);
  const pubBytes = pointToBytes(P);

  // Deterministic nonce derived from scalar + message (RFC 8032 style)
  const scalarBytes = bigintToBytes32LE(p);
  const noncePrefix = blake3(concatBytes([DOMAIN_NONCE, scalarBytes]));
  const r = reduceScalarModL(sha512(concatBytes([noncePrefix, msg])));
  const R = pointToBytes(scalarMult(r, ED_B));

  const k = bytesToBigintLE(sha512(concatBytes([R, pubBytes, msg]))) % ED_L;
  const s = (r + k * p) % ED_L;

  const sig = concatBytes([R, bigintToBytes32LE(s)]);
  return {
    signatureHex: bytesToHex(sig),
    publicKeyHex: bytesToHex(pubBytes),
  };
}
