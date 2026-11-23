/**
 * Address checksum, format, and chain-policy inspector for Kovanica PRO-21 and legacy addresses.
 * Browser-safe: zero Node-only dependencies.
 */

import {
  ADDRESS_LEN,
  ADDRESS_PREFIX,
  ADDRESS_SUFFIX,
  TESTNET_ADDRESS_PREFIX,
  decodeAddress,
  encodeAddress,
  parseLegacyAddress,
} from "./address";
import { CHAIN_IDS, isLegacyAddressAllowed } from "./chains";

export type AddressFormat = "pro21-mainnet" | "pro21-testnet" | "legacy-hex" | "invalid";

export interface AddressInspectionResult {
  valid: boolean;
  input: string;
  format: AddressFormat;
  checksumValid: boolean;
  payloadHex?: string;
  canonicalMainnet?: string;
  canonicalTestnet?: string;
  chainAllowed: boolean | null;
  error?: string;
}

export interface NormalizeAddressListOptions {
  expectedChainId?: number | bigint;
  preferTestnetPrefix?: boolean;
}

export interface NormalizeAddressListResult {
  valid: string[];
  invalid: Array<{ input: string; error: string }>;
}

const LEGACY_CHECKED_HEX_LEN = ADDRESS_PREFIX.length + 72 + ADDRESS_SUFFIX.length;

function bytesToHex0x(bytes: Uint8Array): string {
  let hex = "0x";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ParsedChainPolicy {
  ok: true;
  label: string;
  isTestnet: boolean;
  legacyAllowed: boolean;
}

interface InvalidChainPolicy {
  ok: false;
  error: string;
}

function parseChainPolicy(expectedChainId: number | bigint): ParsedChainPolicy | InvalidChainPolicy {
  if (typeof expectedChainId === "number") {
    if (!Number.isInteger(expectedChainId) || expectedChainId < 0) {
      return { ok: false, error: `Invalid chain ID: ${String(expectedChainId)}` };
    }
    return {
      ok: true,
      label: String(expectedChainId),
      isTestnet: expectedChainId === CHAIN_IDS.TESTNET,
      legacyAllowed: isLegacyAddressAllowed(expectedChainId),
    };
  }

  if (typeof expectedChainId === "bigint") {
    if (expectedChainId < 0n) {
      return { ok: false, error: `Invalid chain ID: ${expectedChainId.toString()}` };
    }
    const asSafeNumber =
      expectedChainId <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(expectedChainId) : -1;
    return {
      ok: true,
      label: expectedChainId.toString(),
      isTestnet: expectedChainId === BigInt(CHAIN_IDS.TESTNET),
      legacyAllowed: asSafeNumber >= 0 ? isLegacyAddressAllowed(asSafeNumber) : false,
    };
  }

  return { ok: false, error: `Invalid chain ID: ${String(expectedChainId)}` };
}

function makeInvalidResult(
  input: string,
  expectedChainId: number | bigint | undefined,
  error: string,
): AddressInspectionResult {
  return {
    valid: false,
    input,
    format: "invalid",
    checksumValid: false,
    chainAllowed: expectedChainId === undefined ? null : false,
    error,
  };
}

function buildParsedResult(
  input: string,
  format: Exclude<AddressFormat, "invalid">,
  payload: Uint8Array,
  checksumValid: boolean,
  expectedChainId?: number | bigint,
): AddressInspectionResult {
  const payloadHex = bytesToHex0x(payload);
  const canonicalMainnet = encodeAddress(payload, ADDRESS_PREFIX);
  const canonicalTestnet = encodeAddress(payload, TESTNET_ADDRESS_PREFIX);

  if (expectedChainId === undefined) {
    return {
      valid: true,
      input,
      format,
      checksumValid,
      payloadHex,
      canonicalMainnet,
      canonicalTestnet,
      chainAllowed: null,
    };
  }

  const policy = parseChainPolicy(expectedChainId);
  if (!policy.ok) {
    return {
      valid: false,
      input,
      format,
      checksumValid,
      payloadHex,
      canonicalMainnet,
      canonicalTestnet,
      chainAllowed: false,
      error: policy.error,
    };
  }

  if (format === "pro21-mainnet") {
    return {
      valid: true,
      input,
      format,
      checksumValid,
      payloadHex,
      canonicalMainnet,
      canonicalTestnet,
      chainAllowed: true,
    };
  }

  if (format === "pro21-testnet") {
    if (policy.isTestnet) {
      return {
        valid: true,
        input,
        format,
        checksumValid,
        payloadHex,
        canonicalMainnet,
        canonicalTestnet,
        chainAllowed: true,
      };
    }
    return {
      valid: false,
      input,
      format,
      checksumValid,
      payloadHex,
      canonicalMainnet,
      canonicalTestnet,
      chainAllowed: false,
      error: `Testnet-prefixed (${TESTNET_ADDRESS_PREFIX}...${ADDRESS_SUFFIX}) addresses are only allowed on Testnet (chain ${CHAIN_IDS.TESTNET}), not chain ${policy.label}`,
    };
  }

  // format === "legacy-hex"
  if (policy.legacyAllowed) {
    return {
      valid: true,
      input,
      format,
      checksumValid,
      payloadHex,
      canonicalMainnet,
      canonicalTestnet,
      chainAllowed: true,
    };
  }

  return {
    valid: false,
    input,
    format,
    checksumValid,
    payloadHex,
    canonicalMainnet,
    canonicalTestnet,
    chainAllowed: false,
    error: `Legacy addresses are not allowed on chain ${policy.label}. Only canonical ${ADDRESS_LEN}-character ${ADDRESS_PREFIX}...${ADDRESS_SUFFIX} PRO-21 addresses are accepted.`,
  };
}

/**
 * Inspects an arbitrary address string for PRO-21 format, checksum validity,
 * canonical representations, and optional chain-policy compliance.
 *
 * Never throws on arbitrary input.
 */
export function inspectAddress(
  input: string,
  expectedChainId?: number | bigint,
): AddressInspectionResult {
  if (typeof input !== "string") {
    return makeInvalidResult(String(input), expectedChainId, "Address must be a string");
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return makeInvalidResult(input, expectedChainId, "Address must not be empty");
  }

  // 1. Canonical PRO-21 mainnet (kvnc...dag, 64 chars)
  if (
    trimmed.length === ADDRESS_LEN &&
    trimmed.startsWith(ADDRESS_PREFIX) &&
    trimmed.endsWith(ADDRESS_SUFFIX)
  ) {
    try {
      const payload = decodeAddress(trimmed, ADDRESS_PREFIX);
      return buildParsedResult(input, "pro21-mainnet", payload, true, expectedChainId);
    } catch (err) {
      return makeInvalidResult(input, expectedChainId, errorMessage(err));
    }
  }

  // 2. Canonical PRO-21 testnet (tknc...dag, 64 chars)
  if (
    trimmed.length === ADDRESS_LEN &&
    trimmed.startsWith(TESTNET_ADDRESS_PREFIX) &&
    trimmed.endsWith(ADDRESS_SUFFIX)
  ) {
    try {
      const payload = decodeAddress(trimmed, TESTNET_ADDRESS_PREFIX);
      return buildParsedResult(input, "pro21-testnet", payload, true, expectedChainId);
    } catch (err) {
      return makeInvalidResult(input, expectedChainId, errorMessage(err));
    }
  }

  // 3. Legacy kvnc<72 hex>dag (32-byte payload + 4-byte blake3 checksum)
  if (
    trimmed.length === LEGACY_CHECKED_HEX_LEN &&
    trimmed.startsWith(ADDRESS_PREFIX) &&
    trimmed.endsWith(ADDRESS_SUFFIX)
  ) {
    try {
      const payload = parseLegacyAddress(trimmed);
      return buildParsedResult(input, "legacy-hex", payload, true, expectedChainId);
    } catch (err) {
      return makeInvalidResult(input, expectedChainId, errorMessage(err));
    }
  }

  // 4. Legacy 32-byte bare hex or 0x-prefixed hex (no embedded checksum)
  if (!trimmed.startsWith(ADDRESS_PREFIX) && !trimmed.startsWith(TESTNET_ADDRESS_PREFIX) && !trimmed.endsWith(ADDRESS_SUFFIX)) {
    try {
      const payload = parseLegacyAddress(trimmed);
      return buildParsedResult(input, "legacy-hex", payload, false, expectedChainId);
    } catch (err) {
      return makeInvalidResult(input, expectedChainId, errorMessage(err));
    }
  }

  // 5. Fallback for malformed kvnc/tknc/...dag strings (wrong length, missing prefix/suffix, etc.)
  try {
    decodeAddress(trimmed);
  } catch (err) {
    return makeInvalidResult(input, expectedChainId, errorMessage(err));
  }

  return makeInvalidResult(input, expectedChainId, "Invalid address format");
}

/**
 * Validates, canonicalizes, and deduplicates a list of address strings in input order,
 * while collecting any invalid or chain-disallowed entries cleanly.
 */
export function normalizeAddressList(
  inputs: readonly string[],
  options?: NormalizeAddressListOptions,
): NormalizeAddressListResult {
  const expectedChainId = options?.expectedChainId;
  const preferTestnetPrefix = options?.preferTestnetPrefix ?? false;

  const valid: string[] = [];
  const invalid: Array<{ input: string; error: string }> = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const result = inspectAddress(input, expectedChainId);
    if (!result.valid || !result.canonicalMainnet || !result.canonicalTestnet) {
      invalid.push({
        input,
        error: result.error ?? "Invalid address",
      });
      continue;
    }

    const canonical = preferTestnetPrefix ? result.canonicalTestnet : result.canonicalMainnet;
    if (!seen.has(canonical)) {
      seen.add(canonical);
      valid.push(canonical);
    }
  }

  return { valid, invalid };
}
