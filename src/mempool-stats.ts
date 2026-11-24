/**
 * Browser-safe mempool fee statistics parser and fee-tier recommendation engine.
 *
 * Uses pure `bigint` arithmetic via {@link applyFeeBuffer} so fee recommendations
 * never lose precision or underpay due to floating-point truncation.
 */

import { DEFAULT_FEE_BUFFER_MULTIPLIER_BPS, applyFeeBuffer } from "./finality";
import type { RequestOptions } from "./types";
import { formatKvnc, parseQuantity } from "./units";

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

// ============================================================================
// Replace-By-Fee (RBF) Fee Bump Helper
// ============================================================================

const BPS_DENOMINATOR = 10_000n;

/** Default RBF fee bump in basis points (`1_500` = +15%). */
export const DEFAULT_RBF_BUMP_BPS = 1_500;

/** Minimum allowed RBF fee bump in basis points (`100` = +1%). */
export const MIN_RBF_BUMP_BPS = 100;

/** Maximum allowed RBF fee bump in basis points (`50_000` = +500%). */
export const MAX_RBF_BUMP_BPS = 50_000;

/** Default minimum absolute fee increment in atoms for RBF (`1n`). */
export const DEFAULT_RBF_MIN_BUMP_ATOMS = 1n;

/** Optional configuration for {@link computeRbfFeeBump}. */
export interface RbfFeeBumpOptions {
  /**
   * Percentage fee bump in basis points (`100` = +1%, `1_500` = +15%, `50_000` = +500%).
   * Must be a safe integer in `[100, 50_000]`.
   * Default: {@link DEFAULT_RBF_BUMP_BPS} (`1_500`).
   */
  bumpBps?: number;
  /**
   * Minimum absolute fee increment in atoms to guarantee a strict fee increase.
   * Must be a `bigint >= 1n`.
   * Default: {@link DEFAULT_RBF_MIN_BUMP_ATOMS} (`1n`).
   */
  minBumpAtoms?: bigint;
}

/** Result returned by {@link computeRbfFeeBump}. */
export interface RbfFeeBumpResult {
  /** Original transaction fee in atoms. */
  previousFee: bigint;
  /** Replacement transaction fee in atoms. Always strictly greater than `previousFee`. */
  bumpedFee: bigint;
  /** Absolute fee increase in atoms (`bumpedFee - previousFee`). Always `>= minBumpAtoms`. */
  delta: bigint;
  /** Applied percentage bump in basis points. */
  bumpBps: number;
}

/**
 * Computes a lossless, overflow-safe Replace-By-Fee (RBF) fee bump using pure `bigint`
 * ceiling division so even small fees strictly increase (`bumpedFee > previousFee`).
 *
 * - Default bump: `+15%` (`bumpBps = 1_500`) with `minBumpAtoms = 1n`.
 * - Rejects negative `previousFee`, non-integer or out-of-range `bumpBps` (`[100, 50_000]`),
 *   and `minBumpAtoms < 1n`.
 */
export function computeRbfFeeBump(
  previousFee: bigint,
  options: RbfFeeBumpOptions = {},
): RbfFeeBumpResult {
  if (typeof previousFee !== "bigint") {
    throw new TypeError(`previousFee must be a bigint, got ${typeof previousFee}`);
  }
  if (previousFee < 0n) {
    throw new RangeError(`previousFee must be non-negative, got ${previousFee}`);
  }

  const bumpBps = options.bumpBps ?? DEFAULT_RBF_BUMP_BPS;
  if (
    typeof bumpBps !== "number" ||
    !Number.isSafeInteger(bumpBps) ||
    bumpBps < MIN_RBF_BUMP_BPS ||
    bumpBps > MAX_RBF_BUMP_BPS
  ) {
    throw new RangeError(
      `bumpBps must be an integer between ${MIN_RBF_BUMP_BPS} and ${MAX_RBF_BUMP_BPS}, got ${bumpBps}`,
    );
  }

  const minBumpAtoms = options.minBumpAtoms ?? DEFAULT_RBF_MIN_BUMP_ATOMS;
  if (typeof minBumpAtoms !== "bigint") {
    throw new TypeError(`minBumpAtoms must be a bigint, got ${typeof minBumpAtoms}`);
  }
  if (minBumpAtoms < 1n) {
    throw new RangeError(`minBumpAtoms must be >= 1n, got ${minBumpAtoms}`);
  }

  const percentDelta =
    previousFee === 0n
      ? 0n
      : (previousFee * BigInt(bumpBps) + (BPS_DENOMINATOR - 1n)) / BPS_DENOMINATOR;
  const delta = percentDelta > minBumpAtoms ? percentDelta : minBumpAtoms;
  const bumpedFee = previousFee + delta;

  return {
    previousFee,
    bumpedFee,
    delta,
    bumpBps,
  };
}

// ============================================================================
// Priority Fee Tier Presets
// ============================================================================

/** Default pending transaction count threshold for `"moderate"` mempool congestion (`50`). */
export const DEFAULT_MODERATE_CONGESTION_PENDING_COUNT = 50;

/** Default pending transaction count threshold for `"high"` mempool congestion (`200`). */
export const DEFAULT_HIGH_CONGESTION_PENDING_COUNT = 200;

/** Supported priority fee tier preset names ordered from lowest to highest urgency. */
export type PriorityFeeTierName = "slow" | "standard" | "fast";

/** Qualitative mempool congestion classification derived from pending transaction count. */
export type MempoolCongestionLevel = "low" | "moderate" | "high";

/** Structured lossless fee estimate for a single priority tier. */
export interface PriorityFeeTier {
  /** Tier name (`"slow"`, `"standard"`, or `"fast"`). */
  tier: PriorityFeeTierName;
  /** Recommended fee in atomic units (`bigint`, lossless). */
  feeAtoms: bigint;
  /** Recommended fee formatted as a decimal KVNC string via {@link formatKvnc}. */
  feeKvnc: string;
  /** Recommended fee rate in atoms per byte (`bigint`, lossless). */
  feePerByte: bigint;
  /** Estimated number of blocks until transaction inclusion for this tier. */
  estimatedInclusionBlocks: number;
}

/** Structured priority fee tier estimate returned by {@link estimatePriorityFeeTiers}. */
export interface PriorityFeeTiersEstimate {
  /** Low-urgency tier derived from `computeFeeRecommendations(...).economy`. */
  slow: PriorityFeeTier;
  /** Default tier derived from `computeFeeRecommendations(...).standard`. Always `>= slow`. */
  standard: PriorityFeeTier;
  /** High-urgency tier derived from `computeFeeRecommendations(...).priority`. Always `>= standard`. */
  fast: PriorityFeeTier;
  /** Number of pending transactions currently in the mempool. */
  pendingCount: number;
  /** Derived mempool congestion level (`"low"`, `"moderate"`, or `"high"`). */
  congestionLevel: MempoolCongestionLevel;
  /** Indicates whether tiers were derived from live mempool data or fallback values. */
  source: "mempool" | "fallback";
  /** Parsed mempool fee statistics used to compute these tiers. */
  stats: MempoolFeeStats;
}

/**
 * Minimal client interface required by {@link estimatePriorityFeeTiers}.
 * Satisfied by {@link KovanicaClient} (via `getMempoolStats`) or any minimal RPC caller
 * implementing `call("kovanica_mempoolStats", [], options)`.
 */
export type PriorityFeeTiersClient =
  | {
      getMempoolStats(
        options?: RequestOptions,
      ): Promise<MempoolFeeStats | Record<string, unknown>>;
    }
  | {
      call<TResult = unknown>(
        method: string,
        params?: unknown,
        options?: RequestOptions,
      ): Promise<TResult>;
    };

/** Optional configuration for {@link estimatePriorityFeeTiers}. */
export interface EstimatePriorityFeeTiersOptions extends FeeRecommendationOptions {
  /**
   * Optional serialized transaction size in bytes used to scale per-byte fee rates
   * into total `feeAtoms` (`feePerByte * txSizeBytes`).
   * Must be a positive integer (`>= 1`). Default: `1n` (per-byte rate).
   */
  txSizeBytes?: number | bigint;
  /**
   * Pending transaction count at or above which congestion is classified as `"moderate"`.
   * Must be a safe integer `>= 1`.
   * Default: {@link DEFAULT_MODERATE_CONGESTION_PENDING_COUNT} (`50`).
   */
  moderateCongestionThreshold?: number;
  /**
   * Pending transaction count at or above which congestion is classified as `"high"`.
   * Must be a safe integer `>= moderateCongestionThreshold`.
   * Default: {@link DEFAULT_HIGH_CONGESTION_PENDING_COUNT} (`200`).
   */
  highCongestionThreshold?: number;
  /** Optional RPC request options (`timeoutMs`, `signal`). */
  requestOptions?: RequestOptions;
}

function resolveTxSizeBytes(txSizeBytes: number | bigint | undefined): bigint {
  if (txSizeBytes === undefined) {
    return 1n;
  }
  if (typeof txSizeBytes === "bigint") {
    if (txSizeBytes < 1n) {
      throw new RangeError(`txSizeBytes must be >= 1, got ${txSizeBytes}`);
    }
    return txSizeBytes;
  }
  if (typeof txSizeBytes === "number") {
    if (!Number.isSafeInteger(txSizeBytes) || txSizeBytes < 1) {
      throw new RangeError(`txSizeBytes must be a positive safe integer, got ${txSizeBytes}`);
    }
    return BigInt(txSizeBytes);
  }
  throw new TypeError(`txSizeBytes must be a bigint or safe integer, got ${typeof txSizeBytes}`);
}

function classifyCongestion(
  pendingCount: number,
  moderateThreshold: number,
  highThreshold: number,
): MempoolCongestionLevel {
  if (pendingCount >= highThreshold) {
    return "high";
  }
  if (pendingCount >= moderateThreshold) {
    return "moderate";
  }
  return "low";
}

function inclusionBlocksForCongestion(
  congestionLevel: MempoolCongestionLevel,
): Record<PriorityFeeTierName, number> {
  switch (congestionLevel) {
    case "high":
      return { slow: 12, standard: 5, fast: 2 };
    case "moderate":
      return { slow: 6, standard: 3, fast: 1 };
    case "low":
      return { slow: 3, standard: 2, fast: 1 };
  }
}

/**
 * Fetches live mempool statistics via `client` (`getMempoolStats` or
 * `call("kovanica_mempoolStats", [])`), parses them with {@link parseMempoolFeeStats},
 * computes monotonic recommendations with {@link computeFeeRecommendations}, and returns
 * structured lossless `bigint` priority fee tiers (`slow`, `standard`, `fast`).
 */
export async function estimatePriorityFeeTiers(
  client: PriorityFeeTiersClient,
  options: EstimatePriorityFeeTiersOptions = {},
): Promise<PriorityFeeTiersEstimate> {
  if (client === null || typeof client !== "object") {
    throw new TypeError("client must implement getMempoolStats() or call()");
  }

  const txSizeBytes = resolveTxSizeBytes(options.txSizeBytes);

  const moderateThreshold =
    options.moderateCongestionThreshold ?? DEFAULT_MODERATE_CONGESTION_PENDING_COUNT;
  if (
    typeof moderateThreshold !== "number" ||
    !Number.isSafeInteger(moderateThreshold) ||
    moderateThreshold < 1
  ) {
    throw new RangeError(
      `moderateCongestionThreshold must be a safe integer >= 1, got ${moderateThreshold}`,
    );
  }

  const highThreshold =
    options.highCongestionThreshold ?? DEFAULT_HIGH_CONGESTION_PENDING_COUNT;
  if (
    typeof highThreshold !== "number" ||
    !Number.isSafeInteger(highThreshold) ||
    highThreshold < moderateThreshold
  ) {
    throw new RangeError(
      `highCongestionThreshold (${highThreshold}) must be a safe integer >= moderateCongestionThreshold (${moderateThreshold})`,
    );
  }

  let rawStats: unknown;
  if ("getMempoolStats" in client && typeof client.getMempoolStats === "function") {
    rawStats = options.requestOptions
      ? await client.getMempoolStats(options.requestOptions)
      : await client.getMempoolStats();
  } else if ("call" in client && typeof client.call === "function") {
    rawStats = options.requestOptions
      ? await client.call<unknown>("kovanica_mempoolStats", [], options.requestOptions)
      : await client.call<unknown>("kovanica_mempoolStats", []);
  } else {
    throw new TypeError("client must implement getMempoolStats() or call()");
  }

  const stats = parseMempoolFeeStats(rawStats);
  const recommendations = computeFeeRecommendations(stats, {
    fallbackBaseFeePerByte: options.fallbackBaseFeePerByte,
    safetyMultiplierBps: options.safetyMultiplierBps,
  });

  const congestionLevel = classifyCongestion(
    stats.pendingCount,
    moderateThreshold,
    highThreshold,
  );
  const inclusionBlocks = inclusionBlocksForCongestion(congestionLevel);

  const buildTier = (tier: PriorityFeeTierName, feePerByte: bigint): PriorityFeeTier => {
    const feeAtoms = feePerByte * txSizeBytes;
    return {
      tier,
      feeAtoms,
      feeKvnc: formatKvnc(feeAtoms),
      feePerByte,
      estimatedInclusionBlocks: inclusionBlocks[tier],
    };
  };

  return {
    slow: buildTier("slow", recommendations.economy),
    standard: buildTier("standard", recommendations.standard),
    fast: buildTier("fast", recommendations.priority),
    pendingCount: stats.pendingCount,
    congestionLevel,
    source: recommendations.source,
    stats,
  };
}
