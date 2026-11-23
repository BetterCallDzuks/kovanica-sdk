/**
 * Air-Gapped Transaction Envelope Encoder & Decoder
 *
 * Browser-safe, zero-Node-dependency wire format (`kvnc-tx:v1:<base64url(JSON)>`)
 * for offline / QR / air-gapped transaction handoff with BLAKE3 integrity verification
 * and canonical network-tag pinning for Mainnet (Chain 1) and Testnet (Chain 2).
 */

import { blake3 } from "@noble/hashes/blake3.js";
import { CHAIN_IDS, NETWORK_TAGS } from "./chains";
import { bytesToHex, hexToBytes } from "./contracts";
import { KovanicaDecodeError } from "./decoders";

export const AIRGAP_ENVELOPE_VERSION = 1 as const;
export const AIRGAP_ENVELOPE_PREFIX = "kvnc-tx:v1:" as const;

export type AirgapTxKind = "transfer" | "call" | "raw";

export interface AirgapTxEnvelope {
  version: typeof AIRGAP_ENVELOPE_VERSION;
  chainId: number;
  networkTag: string;
  kind: AirgapTxKind;
  /** Normalized lowercase `0x`-prefixed raw transaction hex. */
  rawTxHex: string;
  /** Optional normalized lowercase `0x` + 64 hex character signing hash. */
  signingHashHex?: string;
  /** 16 lowercase hex chars = first 8 bytes of BLAKE3 over canonical payload fields. */
  checksumHex: string;
}

export interface EncodeAirgapTxEnvelopeInput {
  chainId: number;
  networkTag?: string;
  kind: AirgapTxKind;
  rawTxHex: string;
  signingHashHex?: string;
}

export interface EncodedAirgapTxEnvelope {
  envelope: AirgapTxEnvelope;
  encoded: string;
}

export interface DecodeAirgapTxEnvelopeOptions {
  expectedChainId?: number;
}

const CHECKSUM_DOMAIN_PREFIX = "KVNC/airgap-tx/v1\n";
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const VALID_KINDS: ReadonlySet<string> = new Set<AirgapTxKind>([
  "transfer",
  "call",
  "raw",
]);

const CANONICAL_NETWORK_TAGS: Readonly<Record<number, string>> = {
  [CHAIN_IDS.MAINNET]: NETWORK_TAGS.MAINNET,
  [CHAIN_IDS.TESTNET]: NETWORK_TAGS.TESTNET,
};

// --- Browser-Safe Strict Base64URL Helpers (RFC 4648 §5, unpadded) ---

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const BASE64URL_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64URL_ALPHABET.length; i++) {
    table[BASE64URL_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

function bytesToBase64Url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      BASE64URL_ALPHABET[(n >>> 18) & 0x3f]! +
      BASE64URL_ALPHABET[(n >>> 12) & 0x3f]! +
      BASE64URL_ALPHABET[(n >>> 6) & 0x3f]! +
      BASE64URL_ALPHABET[n & 0x3f]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out +=
      BASE64URL_ALPHABET[(n >>> 18) & 0x3f]! +
      BASE64URL_ALPHABET[(n >>> 12) & 0x3f]!;
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      BASE64URL_ALPHABET[(n >>> 18) & 0x3f]! +
      BASE64URL_ALPHABET[(n >>> 12) & 0x3f]! +
      BASE64URL_ALPHABET[(n >>> 6) & 0x3f]!;
  }
  return out;
}

function base64UrlToBytes(input: string): Uint8Array {
  if (input.length === 0) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "Air-gap envelope base64url payload must not be empty",
    );
  }
  const rem = input.length % 4;
  if (rem === 1) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      `Invalid base64url length (${input.length}) in air-gap envelope`,
    );
  }

  const outLen = Math.floor((input.length * 3) / 4);
  const out = new Uint8Array(outLen);
  let outPos = 0;

  const decodeChar = (index: number): number => {
    const code = input.charCodeAt(index);
    const val = code < 128 ? BASE64URL_LOOKUP[code]! : -1;
    if (val < 0) {
      throw new KovanicaDecodeError(
        "INVALID_INPUT",
        `Invalid base64url character at offset ${index}`,
        { offset: index },
      );
    }
    return val;
  };

  let i = 0;
  for (; i + 3 < input.length; i += 4) {
    const a = decodeChar(i);
    const b = decodeChar(i + 1);
    const c = decodeChar(i + 2);
    const d = decodeChar(i + 3);
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[outPos++] = (n >>> 16) & 0xff;
    out[outPos++] = (n >>> 8) & 0xff;
    out[outPos++] = n & 0xff;
  }

  if (rem === 2) {
    const a = decodeChar(i);
    const b = decodeChar(i + 1);
    if ((b & 0x0f) !== 0) {
      throw new KovanicaDecodeError(
        "INVALID_INPUT",
        "Non-canonical trailing bits in base64url payload",
        { offset: i + 1 },
      );
    }
    out[outPos++] = (a << 2) | (b >>> 4);
  } else if (rem === 3) {
    const a = decodeChar(i);
    const b = decodeChar(i + 1);
    const c = decodeChar(i + 2);
    if ((c & 0x03) !== 0) {
      throw new KovanicaDecodeError(
        "INVALID_INPUT",
        "Non-canonical trailing bits in base64url payload",
        { offset: i + 2 },
      );
    }
    out[outPos++] = (a << 2) | (b >>> 4);
    out[outPos++] = ((b & 0x0f) << 4) | (c >>> 2);
  }

  return out;
}

// --- Validation & Checksum Helpers ---

function validateChainId(chainId: unknown, field = "chainId"): number {
  if (
    typeof chainId !== "number" ||
    !Number.isSafeInteger(chainId) ||
    chainId <= 0
  ) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      `Invalid ${field}: expected a positive safe integer, got ${String(chainId)}`,
      { field },
    );
  }
  return chainId;
}

function validateAndResolveNetworkTag(
  chainId: number,
  networkTag: unknown,
  allowDefault: boolean,
): string {
  const canonicalTag = CANONICAL_NETWORK_TAGS[chainId];

  if (networkTag === undefined) {
    if (!allowDefault) {
      throw new KovanicaDecodeError(
        "INVALID_INPUT",
        "Missing required field 'networkTag' in air-gap envelope",
        { field: "networkTag" },
      );
    }
    return canonicalTag ?? String(chainId);
  }

  if (typeof networkTag !== "string" || networkTag.trim().length === 0) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "Invalid networkTag: expected a non-empty string",
      { field: "networkTag" },
    );
  }

  if (canonicalTag !== undefined && networkTag !== canonicalTag) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      `Invalid networkTag '${networkTag}' for chainId ${chainId}: expected canonical tag '${canonicalTag}'`,
      { field: "networkTag" },
    );
  }

  return networkTag;
}

function validateKind(kind: unknown): AirgapTxKind {
  if (typeof kind !== "string" || !VALID_KINDS.has(kind)) {
    throw new KovanicaDecodeError(
      "INVALID_VARIANT",
      `Invalid air-gap tx kind '${String(kind)}': expected 'transfer', 'call', or 'raw'`,
      { field: "kind" },
    );
  }
  return kind as AirgapTxKind;
}

function normalizeRawTxHex(rawTxHex: unknown): string {
  if (typeof rawTxHex !== "string") {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "Invalid rawTxHex: expected a hex string",
      { field: "rawTxHex" },
    );
  }
  const trimmed = rawTxHex.trim();
  const clean =
    trimmed.startsWith("0x") || trimmed.startsWith("0X")
      ? trimmed.slice(2)
      : trimmed;
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "Invalid rawTxHex: expected non-empty even-length hex bytes",
      { field: "rawTxHex" },
    );
  }
  const bytes = hexToBytes(clean);
  return `0x${bytesToHex(bytes)}`;
}

function normalizeSigningHashHex(signingHashHex: unknown): string | undefined {
  if (signingHashHex === undefined) {
    return undefined;
  }
  if (typeof signingHashHex !== "string") {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "Invalid signingHashHex: expected a 32-byte hex string",
      { field: "signingHashHex" },
    );
  }
  const trimmed = signingHashHex.trim();
  const clean =
    trimmed.startsWith("0x") || trimmed.startsWith("0X")
      ? trimmed.slice(2)
      : trimmed;
  if (clean.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      `Invalid signingHashHex: expected 32 bytes (64 hex chars), got ${clean.length} hex char(s)`,
      { field: "signingHashHex" },
    );
  }
  const bytes = hexToBytes(clean);
  return `0x${bytesToHex(bytes)}`;
}

function computeEnvelopeChecksum(fields: {
  version: typeof AIRGAP_ENVELOPE_VERSION;
  chainId: number;
  networkTag: string;
  kind: AirgapTxKind;
  rawTxHex: string;
  signingHashHex?: string;
}): string {
  const canonicalPayload: Record<string, unknown> = {
    version: fields.version,
    chainId: fields.chainId,
    networkTag: fields.networkTag,
    kind: fields.kind,
    rawTxHex: fields.rawTxHex,
  };
  if (fields.signingHashHex !== undefined) {
    canonicalPayload.signingHashHex = fields.signingHashHex;
  }
  const preimage = UTF8_ENCODER.encode(
    `${CHECKSUM_DOMAIN_PREFIX}${JSON.stringify(canonicalPayload)}`,
  );
  const digest = blake3(preimage);
  return bytesToHex(digest.slice(0, 8));
}

function constantTimeEqualAscii(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// --- Public API ---

/**
 * Validates fields, pins canonical network tags for Chains 1 & 2, computes the
 * 8-byte BLAKE3 integrity checksum, and encodes an air-gapped transaction envelope
 * as `kvnc-tx:v1:<base64url(JSON)>`.
 */
export function encodeAirgapTxEnvelope(
  input: EncodeAirgapTxEnvelopeInput,
): EncodedAirgapTxEnvelope {
  if (!input || typeof input !== "object") {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "Air-gap envelope input must be an object",
    );
  }

  const chainId = validateChainId(input.chainId);
  const networkTag = validateAndResolveNetworkTag(
    chainId,
    input.networkTag,
    true,
  );
  const kind = validateKind(input.kind);
  const rawTxHex = normalizeRawTxHex(input.rawTxHex);
  const signingHashHex = normalizeSigningHashHex(input.signingHashHex);

  const checksumHex = computeEnvelopeChecksum({
    version: AIRGAP_ENVELOPE_VERSION,
    chainId,
    networkTag,
    kind,
    rawTxHex,
    signingHashHex,
  });

  const envelope: AirgapTxEnvelope =
    signingHashHex !== undefined
      ? {
          version: AIRGAP_ENVELOPE_VERSION,
          chainId,
          networkTag,
          kind,
          rawTxHex,
          signingHashHex,
          checksumHex,
        }
      : {
          version: AIRGAP_ENVELOPE_VERSION,
          chainId,
          networkTag,
          kind,
          rawTxHex,
          checksumHex,
        };

  const jsonBytes = UTF8_ENCODER.encode(JSON.stringify(envelope));
  const encoded = `${AIRGAP_ENVELOPE_PREFIX}${bytesToBase64Url(jsonBytes)}`;

  return { envelope, encoded };
}

/**
 * Decodes and verifies an air-gapped transaction envelope from either the
 * compact `kvnc-tx:v1:<base64url>` transport string or a raw JSON string.
 *
 * Fails closed with `KovanicaDecodeError` on malformed framing, unsupported
 * versions, invalid hex, spoofed Chain 1/2 network tags, checksum mismatches,
 * or `expectedChainId` mismatches.
 */
export function decodeAirgapTxEnvelope(
  encodedOrJson: string,
  options?: DecodeAirgapTxEnvelopeOptions,
): AirgapTxEnvelope {
  if (typeof encodedOrJson !== "string") {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "Air-gap envelope input must be a string",
    );
  }

  const trimmed = encodedOrJson.trim();
  if (trimmed.length === 0) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "Air-gap envelope input must not be empty",
    );
  }

  let jsonText: string;
  if (trimmed.startsWith("{")) {
    jsonText = trimmed;
  } else if (trimmed.startsWith(AIRGAP_ENVELOPE_PREFIX)) {
    const b64 = trimmed.slice(AIRGAP_ENVELOPE_PREFIX.length);
    const jsonBytes = base64UrlToBytes(b64);
    try {
      jsonText = UTF8_DECODER.decode(jsonBytes);
    } catch {
      throw new KovanicaDecodeError(
        "INVALID_UTF8",
        "Air-gap envelope payload is not valid UTF-8",
      );
    }
  } else {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      `Invalid air-gap envelope prefix: expected '${AIRGAP_ENVELOPE_PREFIX}' or JSON object`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "Air-gap envelope payload is not valid JSON",
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "Air-gap envelope JSON must be an object",
    );
  }

  const raw = parsed as Record<string, unknown>;

  if (raw.version !== AIRGAP_ENVELOPE_VERSION) {
    throw new KovanicaDecodeError(
      "INVALID_VARIANT",
      `Unsupported air-gap envelope version: ${String(raw.version)} (expected ${AIRGAP_ENVELOPE_VERSION})`,
      { field: "version" },
    );
  }

  const chainId = validateChainId(raw.chainId);
  const networkTag = validateAndResolveNetworkTag(
    chainId,
    raw.networkTag,
    false,
  );
  const kind = validateKind(raw.kind);

  if (typeof raw.rawTxHex !== "string" || !/^0x[0-9a-f]+$/.test(raw.rawTxHex) || raw.rawTxHex.length % 2 !== 0) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "Invalid rawTxHex in air-gap envelope: expected lowercase 0x-prefixed even-length hex",
      { field: "rawTxHex" },
    );
  }
  const rawTxHex = raw.rawTxHex;

  let signingHashHex: string | undefined;
  if (raw.signingHashHex !== undefined) {
    if (
      typeof raw.signingHashHex !== "string" ||
      !/^0x[0-9a-f]{64}$/.test(raw.signingHashHex)
    ) {
      throw new KovanicaDecodeError(
        "INVALID_INPUT",
        "Invalid signingHashHex in air-gap envelope: expected lowercase 0x + 64 hex chars",
        { field: "signingHashHex" },
      );
    }
    signingHashHex = raw.signingHashHex;
  }

  if (
    typeof raw.checksumHex !== "string" ||
    !/^[0-9a-f]{16}$/.test(raw.checksumHex)
  ) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      "Invalid checksumHex in air-gap envelope: expected 16 lowercase hex chars",
      { field: "checksumHex" },
    );
  }

  const expectedChecksum = computeEnvelopeChecksum({
    version: AIRGAP_ENVELOPE_VERSION,
    chainId,
    networkTag,
    kind,
    rawTxHex,
    signingHashHex,
  });

  if (!constantTimeEqualAscii(raw.checksumHex, expectedChecksum)) {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      `Air-gap envelope checksum mismatch: expected ${expectedChecksum}, got ${raw.checksumHex}`,
      { field: "checksumHex" },
    );
  }

  if (options?.expectedChainId !== undefined) {
    const expectedChainId = validateChainId(
      options.expectedChainId,
      "expectedChainId",
    );
    if (chainId !== expectedChainId) {
      throw new KovanicaDecodeError(
        "INVALID_INPUT",
        `Air-gap envelope chainId mismatch: expected ${expectedChainId}, got ${chainId}`,
        { field: "chainId" },
      );
    }
  }

  return signingHashHex !== undefined
    ? {
        version: AIRGAP_ENVELOPE_VERSION,
        chainId,
        networkTag,
        kind,
        rawTxHex,
        signingHashHex,
        checksumHex: raw.checksumHex,
      }
    : {
        version: AIRGAP_ENVELOPE_VERSION,
        chainId,
        networkTag,
        kind,
        rawTxHex,
        checksumHex: raw.checksumHex,
      };
}
