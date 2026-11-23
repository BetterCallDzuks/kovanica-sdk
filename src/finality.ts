/**
 * Browser-safe transaction fee-buffer estimator and abortable finality watcher.
 *
 * All fee and block-height math uses pure `bigint` arithmetic with ceiling rounding
 * so estimates never underpay due to floating-point truncation.
 */

import { KovanicaAbortError, KovanicaError, KovanicaTimeoutError } from "./errors";
import type { RequestOptions, TransactionReceipt } from "./types";
import { parseQuantity } from "./units";

const BPS_DENOMINATOR = 10_000n;

/** Default fee safety multiplier in basis points (`12_000` = 1.2x). */
export const DEFAULT_FEE_BUFFER_MULTIPLIER_BPS = 12_000;

/** Default target confirmations for {@link waitForTransactionFinality} (`1`). */
export const DEFAULT_FINALITY_CONFIRMATIONS = 1;

/** Default polling interval in milliseconds for {@link waitForTransactionFinality} (`2_000` ms). */
export const DEFAULT_FINALITY_POLL_INTERVAL_MS = 2_000;

/** Default timeout in milliseconds for {@link waitForTransactionFinality} (`60_000` ms). */
export const DEFAULT_FINALITY_TIMEOUT_MS = 60_000;

// ============================================================================
// Fee-Buffer Estimator
// ============================================================================

export interface FeeBufferOptions {
  /**
   * Safety multiplier in basis points (`10_000` = 1.0x, `12_000` = 1.2x).
   * Must be an integer `>= 10_000`.
   * Default: {@link DEFAULT_FEE_BUFFER_MULTIPLIER_BPS} (`12_000`).
   */
  safetyMultiplierBps?: number;
  /**
   * Optional minimum fee floor in atomic units (atoms or atoms/byte).
   * Must be `>= 0n`.
   */
  minFeePerByte?: bigint;
  /**
   * Optional maximum fee cap in atomic units (atoms or atoms/byte).
   * Must be `>= 0n` and `>= minFeePerByte` (if both are specified).
   */
  maxFeeCap?: bigint;
}

export interface FeeBufferEstimate {
  /** Original unbuffered fee in atomic units. */
  baseFee: bigint;
  /** Final buffered fee after applying multiplier, floor, and cap. */
  bufferedFee: bigint;
  /** Applied safety multiplier in basis points. */
  safetyMultiplierBps: number;
  /** `true` when `maxFeeCap` reduced the buffered fee. */
  capped: boolean;
}

/**
 * Applies a ceiling-rounded basis-points safety buffer to a `bigint` base fee,
 * with optional minimum floor (`minFeePerByte`) and maximum cap (`maxFeeCap`).
 *
 * Rejects negative fees, non-bigint fees, and multipliers below `10_000` bps (1.0x).
 */
export function applyFeeBuffer(
  baseFee: bigint,
  options: FeeBufferOptions = {},
): FeeBufferEstimate {
  if (typeof baseFee !== "bigint") {
    throw new TypeError(`baseFee must be a bigint, got ${typeof baseFee}`);
  }
  if (baseFee < 0n) {
    throw new RangeError(`baseFee must be non-negative, got ${baseFee}`);
  }

  const safetyMultiplierBps =
    options.safetyMultiplierBps ?? DEFAULT_FEE_BUFFER_MULTIPLIER_BPS;
  if (
    typeof safetyMultiplierBps !== "number" ||
    !Number.isSafeInteger(safetyMultiplierBps) ||
    safetyMultiplierBps < 10_000
  ) {
    throw new RangeError(
      `safetyMultiplierBps must be an integer >= 10000 (1.0x), got ${safetyMultiplierBps}`,
    );
  }

  const { minFeePerByte, maxFeeCap } = options;

  if (minFeePerByte !== undefined) {
    if (typeof minFeePerByte !== "bigint") {
      throw new TypeError(`minFeePerByte must be a bigint, got ${typeof minFeePerByte}`);
    }
    if (minFeePerByte < 0n) {
      throw new RangeError(`minFeePerByte must be non-negative, got ${minFeePerByte}`);
    }
  }

  if (maxFeeCap !== undefined) {
    if (typeof maxFeeCap !== "bigint") {
      throw new TypeError(`maxFeeCap must be a bigint, got ${typeof maxFeeCap}`);
    }
    if (maxFeeCap < 0n) {
      throw new RangeError(`maxFeeCap must be non-negative, got ${maxFeeCap}`);
    }
  }

  if (
    minFeePerByte !== undefined &&
    maxFeeCap !== undefined &&
    maxFeeCap < minFeePerByte
  ) {
    throw new RangeError(
      `maxFeeCap (${maxFeeCap}) cannot be less than minFeePerByte (${minFeePerByte})`,
    );
  }

  const multiplier = BigInt(safetyMultiplierBps);
  let bufferedFee =
    baseFee === 0n
      ? 0n
      : (baseFee * multiplier + (BPS_DENOMINATOR - 1n)) / BPS_DENOMINATOR;

  if (minFeePerByte !== undefined && bufferedFee < minFeePerByte) {
    bufferedFee = minFeePerByte;
  }

  let capped = false;
  if (maxFeeCap !== undefined && bufferedFee > maxFeeCap) {
    bufferedFee = maxFeeCap;
    capped = true;
  }

  return {
    baseFee,
    bufferedFee,
    safetyMultiplierBps,
    capped,
  };
}

function extractBaseFeeFromEstimate(raw: unknown): bigint {
  if (typeof raw === "bigint" || typeof raw === "number" || typeof raw === "string") {
    return parseQuantity(raw);
  }
  if (raw !== null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const candidate =
      obj.fee ??
      obj.baseFee ??
      obj.feePerByte ??
      obj.fee_per_byte ??
      obj.feeRate ??
      obj.estimatedFee;
    if (candidate !== undefined && candidate !== null) {
      return parseQuantity(candidate);
    }
  }
  throw new TypeError("Unable to extract base fee quantity from estimateFee response");
}

/**
 * Estimates a transaction fee via `client.estimateFee(...)` and applies a safety buffer.
 *
 * Adapts cleanly to `KovanicaClient.estimateFee(options?: RequestOptions): Promise<bigint>`
 * as well as custom clients returning numeric quantities or fee-estimate objects.
 */
export async function estimateTxFeeWithBuffer<
  TParams = RequestOptions | undefined,
  TRaw = unknown,
>(
  client: { estimateFee(params?: TParams): Promise<TRaw> },
  params?: TParams,
  options?: FeeBufferOptions,
): Promise<FeeBufferEstimate & { raw: TRaw }> {
  const raw =
    params === undefined
      ? await client.estimateFee()
      : await client.estimateFee(params);

  const baseFee = extractBaseFeeFromEstimate(raw);
  const estimate = applyFeeBuffer(baseFee, options);
  return {
    ...estimate,
    raw,
  };
}

// ============================================================================
// Abortable Finality Watcher
// ============================================================================

export type FinalityStatus = "pending" | "included" | "finalized";

export interface FinalityProgress {
  /** Normalized `0x`-prefixed 32-byte transaction hash. */
  txHash: string;
  /** Current lifecycle status of the transaction. */
  status: FinalityStatus;
  /** Observed confirmation count (`0` while pending). */
  confirmations: number;
  /** Target confirmations required for finality. */
  targetConfirmations: number;
  /** Block height where the transaction was included, once a receipt exists. */
  blockHeight?: bigint;
  /** Latest chain tip height observed, once a receipt exists. */
  currentHeight?: bigint;
  /** Elapsed time in milliseconds since finality watching started. */
  elapsedMs: number;
}

export interface FinalityReceiptLike {
  blockNumber?: bigint | number | string;
  block_number?: bigint | number | string;
  blockHeight?: bigint | number | string;
  block_height?: bigint | number | string;
}

export interface FinalityResult<TReceipt extends FinalityReceiptLike = TransactionReceipt> {
  /** Normalized `0x`-prefixed 32-byte transaction hash. */
  txHash: string;
  /** Transaction receipt returned by the node. */
  receipt: TReceipt;
  /** Confirmation count observed when finality was reached. */
  confirmations: number;
  /** Block height where the transaction was included. */
  blockHeight: bigint;
  /** Chain tip height observed when finality was reached. */
  currentHeight: bigint;
  /** Elapsed time in milliseconds until finality was reached. */
  elapsedMs: number;
}

export interface WaitForFinalityOptions {
  /**
   * Required confirmation count (`currentHeight - receiptHeight + 1 >= confirmations`).
   * Must be an integer `>= 1`.
   * Default: {@link DEFAULT_FINALITY_CONFIRMATIONS} (`1`).
   */
  confirmations?: number;
  /**
   * Polling interval in milliseconds between receipt/tip checks.
   * Must be a non-negative finite number.
   * Default: {@link DEFAULT_FINALITY_POLL_INTERVAL_MS} (`2_000` ms).
   */
  pollIntervalMs?: number;
  /**
   * Maximum total wait time in milliseconds before throwing {@link KovanicaTimeoutError}.
   * Must be a positive finite number.
   * Default: {@link DEFAULT_FINALITY_TIMEOUT_MS} (`60_000` ms).
   */
  timeoutMs?: number;
  /**
   * Optional cancellation signal. Aborts immediately with {@link KovanicaAbortError}.
   */
  signal?: AbortSignal;
  /**
   * Optional progress callback invoked on each poll cycle (`pending`, `included`, `finalized`).
   */
  onProgress?: (update: FinalityProgress) => void;
  /**
   * Injectable sleep implementation for deterministic tests.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Injectable monotonic/wall-clock timestamp provider in milliseconds (defaults to `Date.now`).
   */
  now?: () => number;
}

/**
 * Minimal client interface required by {@link waitForTransactionFinality}.
 * Satisfied by both `KovanicaClient` (`blockNumber`) and generic clients exposing `getBlockNumber`.
 */
export type FinalityClient<TReceipt extends FinalityReceiptLike = TransactionReceipt> =
  | {
      getTransactionReceipt(
        hash: string,
        options?: RequestOptions,
      ): Promise<TReceipt | null | undefined>;
      getBlockNumber(options?: RequestOptions): Promise<number | bigint | string>;
      blockNumber?: (options?: RequestOptions) => Promise<number | bigint | string>;
    }
  | {
      getTransactionReceipt(
        hash: string,
        options?: RequestOptions,
      ): Promise<TReceipt | null | undefined>;
      blockNumber(options?: RequestOptions): Promise<number | bigint | string>;
      getBlockNumber?: (options?: RequestOptions) => Promise<number | bigint | string>;
    };

function normalizeAndValidateTxHash(txHash: string): string {
  if (typeof txHash !== "string") {
    throw new TypeError("Invalid transaction hash: expected a 32-byte hex string");
  }
  const trimmed = txHash.trim();
  const clean =
    trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  if (clean.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new KovanicaError(
      `Invalid transaction hash: expected 32-byte (64-character) hex string, got "${txHash}"`,
    );
  }
  return `0x${clean.toLowerCase()}`;
}

function defaultSleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new KovanicaAbortError("Finality watch was aborted"));
  }
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new KovanicaAbortError("Finality watch was aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function extractReceiptBlockHeight(receipt: FinalityReceiptLike): bigint {
  const rawHeight =
    receipt.blockNumber ??
    receipt.blockHeight ??
    receipt.block_height ??
    receipt.block_number;
  if (rawHeight === undefined || rawHeight === null) {
    throw new KovanicaError(
      "Transaction receipt does not contain a blockNumber, blockHeight, or block_height field",
    );
  }
  const height = parseQuantity(rawHeight);
  if (height < 0n) {
    throw new RangeError(`Receipt block height cannot be negative, got ${height}`);
  }
  return height;
}

async function fetchTipHeight<TReceipt extends FinalityReceiptLike>(
  client: FinalityClient<TReceipt>,
  requestOptions?: RequestOptions,
): Promise<bigint> {
  let raw: number | bigint | string;
  if (typeof client.getBlockNumber === "function") {
    raw = requestOptions
      ? await client.getBlockNumber(requestOptions)
      : await client.getBlockNumber();
  } else if (typeof client.blockNumber === "function") {
    raw = requestOptions
      ? await client.blockNumber(requestOptions)
      : await client.blockNumber();
  } else {
    throw new TypeError("Client must implement getBlockNumber() or blockNumber()");
  }
  const height = parseQuantity(raw);
  if (height < 0n) {
    throw new RangeError(`Current block height cannot be negative, got ${height}`);
  }
  return height;
}

/**
 * Watches a transaction until it is included in a block and reaches the requested
 * number of confirmations (`currentHeight - receiptHeight + 1 >= confirmations`).
 *
 * - Validates `txHash` as a 32-byte (64-character) hex string.
 * - Emits `onProgress` updates for `pending`, `included`, and `finalized` states.
 * - Supports immediate and mid-flight cancellation via `AbortSignal` (`KovanicaAbortError`).
 * - Rejects with `KovanicaTimeoutError` when `timeoutMs` elapses before finality.
 */
export async function waitForTransactionFinality<
  TReceipt extends FinalityReceiptLike = TransactionReceipt,
>(
  client: FinalityClient<TReceipt>,
  txHash: string,
  options: WaitForFinalityOptions = {},
): Promise<FinalityResult<TReceipt>> {
  const normalizedHash = normalizeAndValidateTxHash(txHash);

  const targetConfirmations = options.confirmations ?? DEFAULT_FINALITY_CONFIRMATIONS;
  if (
    typeof targetConfirmations !== "number" ||
    !Number.isSafeInteger(targetConfirmations) ||
    targetConfirmations < 1
  ) {
    throw new RangeError(
      `confirmations must be an integer >= 1, got ${targetConfirmations}`,
    );
  }

  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_FINALITY_POLL_INTERVAL_MS;
  if (
    typeof pollIntervalMs !== "number" ||
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs < 0
  ) {
    throw new RangeError(
      `pollIntervalMs must be a non-negative finite number, got ${pollIntervalMs}`,
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_FINALITY_TIMEOUT_MS;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new RangeError(`timeoutMs must be a positive finite number, got ${timeoutMs}`);
  }

  const {
    signal,
    onProgress,
    sleep = defaultSleepWithAbort,
    now = Date.now,
  } = options;

  if (signal?.aborted) {
    throw new KovanicaAbortError("Finality watch was aborted");
  }

  const startedAt = now();
  const getElapsedMs = () => Math.max(0, now() - startedAt);
  const targetConfirmationsBig = BigInt(targetConfirmations);
  const requestOptions: RequestOptions | undefined = signal ? { signal } : undefined;

  while (true) {
    if (signal?.aborted) {
      throw new KovanicaAbortError("Finality watch was aborted");
    }

    const receipt = requestOptions
      ? await client.getTransactionReceipt(normalizedHash, requestOptions)
      : await client.getTransactionReceipt(normalizedHash);

    if (signal?.aborted) {
      throw new KovanicaAbortError("Finality watch was aborted");
    }

    if (receipt != null) {
      const blockHeight = extractReceiptBlockHeight(receipt);
      const currentHeight = await fetchTipHeight(client, requestOptions);

      if (signal?.aborted) {
        throw new KovanicaAbortError("Finality watch was aborted");
      }

      const confirmationsBig =
        currentHeight >= blockHeight ? currentHeight - blockHeight + 1n : 0n;
      const confirmationsCount =
        confirmationsBig > BigInt(Number.MAX_SAFE_INTEGER)
          ? Number.MAX_SAFE_INTEGER
          : Number(confirmationsBig);
      const elapsedMs = getElapsedMs();

      if (confirmationsBig >= targetConfirmationsBig) {
        onProgress?.({
          txHash: normalizedHash,
          status: "finalized",
          confirmations: confirmationsCount,
          targetConfirmations,
          blockHeight,
          currentHeight,
          elapsedMs,
        });

        return {
          txHash: normalizedHash,
          receipt,
          confirmations: confirmationsCount,
          blockHeight,
          currentHeight,
          elapsedMs,
        };
      }

      onProgress?.({
        txHash: normalizedHash,
        status: "included",
        confirmations: confirmationsCount,
        targetConfirmations,
        blockHeight,
        currentHeight,
        elapsedMs,
      });
    } else {
      onProgress?.({
        txHash: normalizedHash,
        status: "pending",
        confirmations: 0,
        targetConfirmations,
        elapsedMs: getElapsedMs(),
      });
    }

    const remainingMs = timeoutMs - getElapsedMs();
    if (remainingMs <= 0) {
      throw new KovanicaTimeoutError(
        timeoutMs,
        `Timed out waiting for finality of ${normalizedHash} (${targetConfirmations} confirmations) after ${timeoutMs}ms`,
      );
    }

    const sleepMs = Math.min(pollIntervalMs, remainingMs);
    try {
      await sleep(sleepMs, signal);
    } catch (err: unknown) {
      if (err instanceof KovanicaAbortError) {
        throw err;
      }
      if (signal?.aborted) {
        throw new KovanicaAbortError("Finality watch was aborted");
      }
      throw err;
    }

    if (signal?.aborted) {
      throw new KovanicaAbortError("Finality watch was aborted");
    }

    if (getElapsedMs() >= timeoutMs) {
      throw new KovanicaTimeoutError(
        timeoutMs,
        `Timed out waiting for finality of ${normalizedHash} (${targetConfirmations} confirmations) after ${timeoutMs}ms`,
      );
    }
  }
}
