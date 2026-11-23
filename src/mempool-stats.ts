/**
 * Browser-safe mempool fee statistics parser and fee-tier recommendation engine.
 *
 * Uses pure `bigint` arithmetic via {@link applyFeeBuffer} so fee recommendations
 * never lose precision or underpay due to floating-point truncation.
 */

import { DEFAULT_FEE_BUFFER_MULTIPLIER_BPS, applyFeeBuffer } from "./finality";
import { parseQuantity } from "./units";

/**
 * Parsed response from `kovanica_mempoolStats`.
 * Fee fields are `null` when the mempool is empty.
 */
export interface MempoolFeeStats {
  /** Number of pending transactions currently in the mempool. */
  pendingCount: number;
  /** Aggregate serialized byte size of pending transactions in the mempool. */
  totalBytes: number;
  /** Minimum fee rate (atoms per byte) among pending transactions, or `null` when empty. */
  minFeePerByte: bigint | null;
  /** Median (50th percentile) fee rate (atoms per byte), or `null` when empty. */
  p50FeePerByte: bigint | null;
  /** 90th percentile fee rate (atoms per byte), or `null` when empty. */
  p90FeePerByte: bigint | null;
  /** Maximum fee rate (atoms per byte) among pending transactions, or `null` when empty. */
  maxFeePerByte: bigint | null;
}

/** Supported fee recommendation tiers ordered from lowest to highest urgency. */
export type FeeRecommendationTier = "economy" | "standard" | "priority";

/** Recommended fee rates (in atoms per byte) across all three urgency tiers. */
export interface FeeRecommendations {
  /** Low-urgency fee rate (atoms per byte). */
  economy: bigint;
  /** Default buffered fee rate (atoms per byte). Always `>= economy`. */
  standard: bigint;
  /** High-urgency buffered fee rate (atoms per byte). Always `>= standard`. */
  priority: bigint;
  /** Indicates whether recommendations were derived from live mempool data or fallback values. */
  source: "mempool" | "fallback";
}

/** Optional configuration for {@link computeFeeRecommendations}. */
export interface FeeRecommendationOptions {
  /**
   * Fallback base fee rate (atoms per byte) used when the mempool is empty (`p50FeePerByte === null`)
   * or when `minFeePerByte` is missing.
   * Must be a non-negative `bigint`. Default: `1n`.
   */
  fallbackBaseFeePerByte?: bigint;
  /**
   * Safety multiplier in basis points (`10_000` = 1.0x, `12_000` = 1.2x) applied to
   * `standard` and `priority` tiers via {@link applyFeeBuffer}.
   * Must be a safe integer `>= 10_000`.
   * Default: {@link DEFAULT_FEE_BUFFER_MULTIPLIER_BPS} (`12_000`).
   */
  safetyMultiplierBps?: number;
}

const DEFAULT_FALLBACK_BASE_FEE_PER_BYTE = 1n;

function parseNonNegativeSafeCount(value: unknown, fieldName: string): number {
  if (value === undefined || value === null) {
    throw new TypeError(`Missing required mempool stats field "${fieldName}"`);
  }
  const parsed = parseQuantity(value);
  if (parsed < 0n) {
    throw new RangeError(`${fieldName} must be non-negative, got ${parsed}`);
  }
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${fieldName} exceeds Number.MAX_SAFE_INTEGER: ${parsed}`);
  }
  return Number(parsed);
}

function parseNullableNonNegativeFee(value: unknown, fieldName: string): bigint | null {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = parseQuantity(value);
  if (parsed < 0n) {
    throw new RangeError(`${fieldName} must be non-negative, got ${parsed}`);
  }
  return parsed;
}

/**
 * Parses a raw `kovanica_mempoolStats` RPC response into a typed {@link MempoolFeeStats}.
 *
 * Accepts both snake_case (native L1 JSON-RPC format) and camelCase field names, and supports
 * hex quantity strings, decimal strings, safe integers, and `bigint` values.
 */
export function parseMempoolFeeStats(raw: unknown): MempoolFeeStats {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("Invalid mempool stats payload: expected a non-null object");
  }

  const obj = raw as Record<string, unknown>;

  const pendingCount = parseNonNegativeSafeCount(
    obj.pendingCount ?? obj.pending_count,
    "pendingCount",
  );
  const totalBytes = parseNonNegativeSafeCount(
    obj.totalBytes ?? obj.total_bytes,
    "totalBytes",
  );
  const minFeePerByte = parseNullableNonNegativeFee(
    obj.minFeePerByte ?? obj.min_fee_per_byte,
    "minFeePerByte",
  );
  const p50FeePerByte = parseNullableNonNegativeFee(
    obj.p50FeePerByte ?? obj.p50_fee_per_byte,
    "p50FeePerByte",
  );
  const p90FeePerByte = parseNullableNonNegativeFee(
    obj.p90FeePerByte ?? obj.p90_fee_per_byte,
    "p90FeePerByte",
  );
  const maxFeePerByte = parseNullableNonNegativeFee(
    obj.maxFeePerByte ?? obj.max_fee_per_byte,
    "maxFeePerByte",
  );

  return {
    pendingCount,
    totalBytes,
    minFeePerByte,
    p50FeePerByte,
    p90FeePerByte,
    maxFeePerByte,
  };
}

/**
 * Computes monotonic (`economy <= standard <= priority`) fee-per-byte recommendations
 * from {@link MempoolFeeStats}.
 *
 * - When `stats.p50FeePerByte !== null` (`source: "mempool"`):
 *   - `economy`: `minFeePerByte` (or `fallbackBaseFeePerByte` if `minFeePerByte` is `null`)
 *   - `standard`: `applyFeeBuffer(p50FeePerByte, { safetyMultiplierBps }).bufferedFee`, clamped `>= economy`
 *   - `priority`: `applyFeeBuffer(p90FeePerByte ?? maxFeePerByte ?? p50FeePerByte, { safetyMultiplierBps }).bufferedFee`, clamped `>= standard`
 * - When the mempool is empty (`stats.p50FeePerByte === null`, `source: "fallback"`):
 *   - Falls back cleanly to `fallbackBaseFeePerByte` (default `1n`) with monotonic buffered tiers.
 */
export function computeFeeRecommendations(
  stats: MempoolFeeStats,
  options?: FeeRecommendationOptions,
): FeeRecommendations {
  const fallback = options?.fallbackBaseFeePerByte ?? DEFAULT_FALLBACK_BASE_FEE_PER_BYTE;
  if (typeof fallback !== "bigint") {
    throw new TypeError(`fallbackBaseFeePerByte must be a bigint, got ${typeof fallback}`);
  }
  if (fallback < 0n) {
    throw new RangeError(`fallbackBaseFeePerByte must be non-negative, got ${fallback}`);
  }

  const safetyMultiplierBps = options?.safetyMultiplierBps ?? DEFAULT_FEE_BUFFER_MULTIPLIER_BPS;
  const bufferOpts = { safetyMultiplierBps };

  if (stats.p50FeePerByte === null) {
    const economy = fallback;
    const standard = applyFeeBuffer(fallback, bufferOpts).bufferedFee;
    const priority = applyFeeBuffer(standard, bufferOpts).bufferedFee;
    return {
      economy,
      standard: standard < economy ? economy : standard,
      priority: priority < standard ? standard : priority,
      source: "fallback",
    };
  }

  const economy = stats.minFeePerByte ?? fallback;
  if (typeof economy !== "bigint") {
    throw new TypeError(`minFeePerByte must be a bigint or null, got ${typeof economy}`);
  }
  if (economy < 0n) {
    throw new RangeError(`minFeePerByte must be non-negative, got ${economy}`);
  }

  const bufferedStandard = applyFeeBuffer(stats.p50FeePerByte, bufferOpts).bufferedFee;
  const standard = bufferedStandard < economy ? economy : bufferedStandard;

  const p90Base = stats.p90FeePerByte ?? stats.maxFeePerByte ?? stats.p50FeePerByte;
  const bufferedPriority = applyFeeBuffer(p90Base, bufferOpts).bufferedFee;
  const priority = bufferedPriority < standard ? standard : bufferedPriority;

  return {
    economy,
    standard,
    priority,
    source: "mempool",
  };
}
