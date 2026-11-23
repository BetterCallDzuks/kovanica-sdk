/**
 * Paginated Contract Log History & Typed WebSocket Event Subscriptions.
 *
 * - {@link getContractLogHistory}: Bounded sequential block-range pagination over `kovanica_getLogs`
 *   with fail-closed input validation, `AbortSignal` cancellation between chunks, and optional
 *   typed Bincode decoding via {@link decodeTransactionReceiptLogs}.
 * - {@link subscribeContractEvents}: Typed wrapper around `KovanicaWsClient.subscribeLogs` that
 *   decodes incoming execution log payloads via {@link decodeContractLog} and isolates malformed
 *   frames via `onDecodeError` without terminating the subscription loop.
 */

import {
  ADDRESS_PREFIX,
  TESTNET_ADDRESS_PREFIX,
  encodeAddress,
} from "./address";
import { parseContractAddress } from "./contracts";
import {
  type ContractLogKind,
  type ContractLogKindResolver,
  type DecodedContractLogByKind,
  type DecodedTransactionReceiptLog,
  type DecodedTransactionReceiptLogByKind,
  KovanicaDecodeError,
  type ReceiptLogEntry,
  decodeContractLog,
  decodeTransactionReceiptLogs,
} from "./decoders";
import { KovanicaAbortError } from "./errors";
import type { HexString, KovanicaAddress, RequestOptions } from "./types";
import { toHexQuantity } from "./units";
import type {
  WsExecutionEvent,
  WsLogFilter,
  WsLogReceipt,
  WsSubscriptionCallback,
} from "./ws";

/** Default maximum number of blocks queried per `kovanica_getLogs` chunk. */
export const DEFAULT_LOG_HISTORY_CHUNK_SIZE = 1_000;

const VALID_CONTRACT_LOG_KINDS: ReadonlySet<ContractLogKind> = new Set<ContractLogKind>([
  "htlc",
  "vault",
  "multisig_state",
  "multisig_tx",
  "token_metadata",
  "token_pool",
  "name",
  "nft_metadata",
  "escrow",
]);

// ============================================================================
// Paginated Contract Log History (`getContractLogHistory`)
// ============================================================================

/** Raw log entry returned by `kovanica_getLogs`. */
export interface ContractLogEntry {
  address?: string;
  topics?: ReadonlyArray<string>;
  topic?: string | number[];
  data: string | Uint8Array | number[];
  blockNumber?: bigint | number | string;
  blockHash?: string;
  transactionHash?: string;
  transactionIndex?: bigint | number | string | null;
  logIndex?: bigint | number | string;
  [key: string]: unknown;
}

/** Filter object passed to `kovanica_getLogs` for each block-range chunk. */
export interface GetLogsFilter {
  fromBlock: HexString;
  toBlock: HexString;
  address?: KovanicaAddress;
  topics?: ReadonlyArray<string | ReadonlyArray<string> | null>;
}

/**
 * Minimal client interface required by {@link getContractLogHistory}.
 * Satisfied by {@link KovanicaClient} (via `call("kovanica_getLogs", ...)`) or any
 * client implementing `getLogs(filter, options)`.
 */
export type GetLogsClient =
  | {
      getLogs(
        filter: GetLogsFilter,
        options?: RequestOptions,
      ): Promise<ReadonlyArray<ContractLogEntry>>;
    }
  | {
      call<TResult = unknown>(
        method: string,
        params?: unknown,
        options?: RequestOptions,
      ): Promise<TResult>;
    };

/** Options for {@link getContractLogHistory}. */
export interface GetContractLogHistoryOptions<
  K extends ContractLogKind = ContractLogKind,
> {
  /** Optional contract address (PRO-21 `kvnc...dag` / `tknc...dag`, 32-byte hex, or 32-byte `Uint8Array`). */
  contract?: Uint8Array | string;
  /** Inclusive start block height (non-negative `bigint` or safe integer `number`). */
  fromBlock: bigint | number;
  /** Inclusive end block height (non-negative `bigint` or safe integer `number`, must be `>= fromBlock`). */
  toBlock: bigint | number;
  /** Maximum number of blocks per sequential RPC chunk. Positive safe integer; defaults to `1_000`. */
  chunkSize?: number;
  /** Optional static {@link ContractLogKind} or resolver callback to decode matching logs. */
  kind?: K | ContractLogKindResolver<K>;
  /** Optional positional topic filters forwarded to `kovanica_getLogs`. */
  topics?: ReadonlyArray<string | ReadonlyArray<string> | null>;
  /** Optional cancellation signal checked before and between chunks, and forwarded to each RPC call. */
  signal?: AbortSignal;
  /** Optional per-chunk RPC request options (`timeoutMs`, `signal`). */
  requestOptions?: RequestOptions;
}

/** Result returned by {@link getContractLogHistory}. */
export interface ContractLogHistoryResult<
  K extends ContractLogKind = ContractLogKind,
> {
  /** All raw logs collected in block-chunk order across `[fromBlock, toBlock]`. */
  logs: ContractLogEntry[];
  /** Decoded logs when `options.kind` is provided; empty array otherwise. */
  decodedLogs: Array<DecodedTransactionReceiptLogByKind<K>>;
  /** Number of sequential `kovanica_getLogs` chunk requests executed. */
  chunksQueried: number;
  /** Normalized inclusive start block height as `bigint`. */
  fromBlock: bigint;
  /** Normalized inclusive end block height as `bigint`. */
  toBlock: bigint;
}

function parseNonNegativeBlockNumber(value: bigint | number, field: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new RangeError(`getContractLogHistory: ${field} must be non-negative, got ${value}`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        `getContractLogHistory: ${field} must be a non-negative safe integer, got ${value}`,
      );
    }
    return BigInt(value);
  }
  throw new TypeError(
    `getContractLogHistory: ${field} must be a bigint or non-negative safe integer`,
  );
}

function normalizeOptionalContractAddress(contract: Uint8Array | string | undefined): string | undefined {
  if (contract === undefined) {
    return undefined;
  }
  if (typeof contract !== "string" && !(contract instanceof Uint8Array)) {
    throw new TypeError(
      "getContractLogHistory: contract must be a PRO-21 address, 32-byte hex string, or 32-byte Uint8Array",
    );
  }
  const bytes = parseContractAddress(contract);
  const prefix =
    typeof contract === "string" && contract.trim().startsWith(TESTNET_ADDRESS_PREFIX)
      ? TESTNET_ADDRESS_PREFIX
      : ADDRESS_PREFIX;
  return encodeAddress(bytes, prefix);
}

function validateContractLogKind(kind: unknown, field: string): asserts kind is ContractLogKind {
  if (typeof kind !== "string" || !VALID_CONTRACT_LOG_KINDS.has(kind as ContractLogKind)) {
    throw new KovanicaDecodeError("INVALID_INPUT", `Unknown contract log kind: ${String(kind)}`, {
      field,
    });
  }
}

function toDecodableLogData(data: unknown, context: string): Uint8Array | string {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (typeof data === "string") {
    return data;
  }
  if (Array.isArray(data)) {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
      const byte = data[i];
      if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new KovanicaDecodeError(
          "INVALID_INPUT",
          `${context}: invalid byte value at index ${i}`,
          { offset: i, field: "data" },
        );
      }
      out[i] = byte;
    }
    return out;
  }
  throw new KovanicaDecodeError(
    "INVALID_INPUT",
    `${context}: expected log data to be a hex string, Uint8Array, or byte array`,
    { field: "data" },
  );
}

function normalizeLogForDecoding(log: ContractLogEntry, index: number): ReceiptLogEntry {
  if (!log || typeof log !== "object") {
    throw new KovanicaDecodeError(
      "INVALID_INPUT",
      `getContractLogHistory: invalid log entry at index ${index}`,
      { field: `logs[${index}]` },
    );
  }
  return {
    ...(log.address !== undefined ? { address: log.address } : {}),
    ...(log.topics !== undefined ? { topics: log.topics } : {}),
    data: toDecodableLogData(log.data, `getContractLogHistory.logs[${index}]`),
  };
}

function createCombinedRequestOptions(
  signal: AbortSignal | undefined,
  requestOptions: RequestOptions | undefined,
): { options: RequestOptions | undefined; cleanup: () => void } {
  const reqSignal = requestOptions?.signal;
  if (!signal && !reqSignal) {
    return { options: requestOptions, cleanup: () => {} };
  }
  if (!signal) {
    return { options: requestOptions, cleanup: () => {} };
  }
  if (!reqSignal || reqSignal === signal) {
    return {
      options: { ...requestOptions, signal },
      cleanup: () => {},
    };
  }

  // Combine two distinct AbortSignals without requiring AbortSignal.any on Node 18
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal.aborted || reqSignal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
    reqSignal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    options: { ...requestOptions, signal: controller.signal },
    cleanup: () => {
      signal.removeEventListener("abort", onAbort);
      reqSignal.removeEventListener("abort", onAbort);
    },
  };
}

async function fetchLogsChunk(
  client: GetLogsClient,
  filter: GetLogsFilter,
  requestOptions: RequestOptions | undefined,
): Promise<ReadonlyArray<ContractLogEntry>> {
  const candidate = client as {
    getLogs?: (
      filter: GetLogsFilter,
      options?: RequestOptions,
    ) => Promise<ReadonlyArray<ContractLogEntry>>;
    call?: <TResult = unknown>(
      method: string,
      params?: unknown,
      options?: RequestOptions,
    ) => Promise<TResult>;
  };

  if (typeof candidate.getLogs === "function") {
    return candidate.getLogs(filter, requestOptions);
  }
  if (typeof candidate.call === "function") {
    return candidate.call<ReadonlyArray<ContractLogEntry>>(
      "kovanica_getLogs",
      [filter],
      requestOptions,
    );
  }
  throw new TypeError("getContractLogHistory: client must implement getLogs() or call()");
}

/**
 * Fetches contract logs across an arbitrary inclusive block range `[fromBlock, toBlock]`
 * by issuing bounded sequential `kovanica_getLogs` chunk queries.
 *
 * - Validates `fromBlock`, `toBlock`, `chunkSize`, optional `contract`, `topics`, and `kind`
 *   fail-closed before any RPC I/O.
 * - Honors `AbortSignal` before and between chunks so callers can cancel long scans cleanly.
 * - When `options.kind` is provided, decodes matching logs via {@link decodeTransactionReceiptLogs}.
 */
export async function getContractLogHistory<K extends ContractLogKind>(
  client: GetLogsClient,
  options: GetContractLogHistoryOptions<K> & {
    kind: K | ContractLogKindResolver<K>;
  },
): Promise<ContractLogHistoryResult<K>>;
export async function getContractLogHistory(
  client: GetLogsClient,
  options: GetContractLogHistoryOptions,
): Promise<ContractLogHistoryResult>;
export async function getContractLogHistory(
  client: GetLogsClient,
  options: GetContractLogHistoryOptions,
): Promise<ContractLogHistoryResult> {
  if (
    !client ||
    typeof client !== "object" ||
    (typeof (client as { getLogs?: unknown }).getLogs !== "function" &&
      typeof (client as { call?: unknown }).call !== "function")
  ) {
    throw new TypeError("getContractLogHistory: client must implement getLogs() or call()");
  }

  if (!options || typeof options !== "object") {
    throw new TypeError("getContractLogHistory: options must be an object");
  }

  const fromBlock = parseNonNegativeBlockNumber(options.fromBlock, "fromBlock");
  const toBlock = parseNonNegativeBlockNumber(options.toBlock, "toBlock");
  if (fromBlock > toBlock) {
    throw new RangeError(
      `getContractLogHistory: fromBlock (${fromBlock}) must be <= toBlock (${toBlock})`,
    );
  }

  const chunkSize = options.chunkSize ?? DEFAULT_LOG_HISTORY_CHUNK_SIZE;
  if (typeof chunkSize !== "number" || !Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError(
      `getContractLogHistory: chunkSize must be a positive safe integer (>= 1), got ${String(chunkSize)}`,
    );
  }

  const canonicalContract = normalizeOptionalContractAddress(options.contract);

  if (options.topics !== undefined && !Array.isArray(options.topics)) {
    throw new TypeError("getContractLogHistory: topics must be an array when provided");
  }

  if (options.kind !== undefined && typeof options.kind !== "function") {
    validateContractLogKind(options.kind, "kind");
  }

  const isAborted = (): boolean =>
    Boolean(options.signal?.aborted || options.requestOptions?.signal?.aborted);

  if (isAborted()) {
    throw new KovanicaAbortError("Log history query was aborted");
  }

  const { options: chunkRequestOptions, cleanup } = createCombinedRequestOptions(
    options.signal,
    options.requestOptions,
  );

  const step = BigInt(chunkSize);
  const logs: ContractLogEntry[] = [];
  let chunksQueried = 0;

  try {
    let start = fromBlock;
    while (start <= toBlock) {
      if (isAborted()) {
        throw new KovanicaAbortError("Log history query was aborted");
      }

      const candidateEnd = start + step - 1n;
      const end = candidateEnd < toBlock ? candidateEnd : toBlock;

      const filter: GetLogsFilter = {
        fromBlock: toHexQuantity(start),
        toBlock: toHexQuantity(end),
        ...(canonicalContract !== undefined ? { address: canonicalContract } : {}),
        ...(options.topics !== undefined ? { topics: options.topics } : {}),
      };

      const chunkLogs = await fetchLogsChunk(client, filter, chunkRequestOptions);
      chunksQueried += 1;

      if (!Array.isArray(chunkLogs)) {
        throw new KovanicaDecodeError(
          "INVALID_INPUT",
          "kovanica_getLogs: expected an array of log entries",
          { field: "logs" },
        );
      }

      logs.push(...chunkLogs);
      start = end + 1n;
    }
  } finally {
    cleanup();
  }

  if (isAborted()) {
    throw new KovanicaAbortError("Log history query was aborted");
  }

  let decodedLogs: DecodedTransactionReceiptLog[] = [];
  if (options.kind !== undefined) {
    const normalizedLogs = logs.map((log, i) => normalizeLogForDecoding(log, i));
    decodedLogs = decodeTransactionReceiptLogs({ logs: normalizedLogs }, options.kind);
  }

  return {
    logs,
    decodedLogs,
    chunksQueried,
    fromBlock,
    toBlock,
  };
}

// ============================================================================
// Typed Live Contract Event Stream (`subscribeContractEvents`)
// ============================================================================

/**
 * Minimal WebSocket client interface required by {@link subscribeContractEvents}.
 * Satisfied by {@link KovanicaWsClient}.
 */
export interface SubscribeLogsWsClient {
  subscribeLogs(
    filter: WsLogFilter | null | undefined,
    cb: WsSubscriptionCallback<WsLogReceipt[]>,
  ): Promise<string>;
  unsubscribe(subscriptionId: string): Promise<boolean>;
}

/** Typed decoded contract event emitted to `onEvent` by {@link subscribeContractEvents}. */
export type DecodedContractEvent<K extends ContractLogKind = ContractLogKind> = {
  [P in K]: {
    kind: P;
    record: DecodedContractLogByKind<P>["record"];
    raw: WsExecutionEvent | ContractLogEntry;
    receipt?: WsLogReceipt;
  };
}[K];

/** Options for {@link subscribeContractEvents}. */
export interface SubscribeContractEventsOptions<K extends ContractLogKind = ContractLogKind> {
  /** Optional WebSocket log filter (`address`, `topics`) forwarded to `wsClient.subscribeLogs`. */
  filter?: WsLogFilter | null;
  /** Canonical contract log kind used to decode incoming log payloads via {@link decodeContractLog}. */
  kind: K;
  /**
   * Optional error handler invoked when an incoming frame or log payload cannot be decoded.
   * Malformed frames are isolated and never crash the subscription loop.
   */
  onDecodeError?: (error: Error, rawLog: unknown) => void;
}

/** Active subscription handle returned by {@link subscribeContractEvents}. */
export interface ContractEventSubscriptionHandle {
  /** Subscription identifier returned by `wsClient.subscribeLogs`. */
  subscriptionId: string;
  /** Unsubscribes from the stream via `wsClient.unsubscribe(subscriptionId)`. */
  unsubscribe: () => Promise<boolean>;
}

function isReceiptWithEvents(value: unknown): value is WsLogReceipt {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as { events?: unknown }).events)
  );
}

/**
 * Subscribes to live contract execution logs via `wsClient.subscribeLogs`, decodes each
 * incoming event payload via {@link decodeContractLog}, and forwards typed `{ kind, record, raw }`
 * events to `onEvent`.
 *
 * - Validates `wsClient`, `options.kind`, `onEvent`, and `onDecodeError` fail-closed before subscribing.
 * - Supports both Kovanica receipt-array frames (`WsLogReceipt[]` containing `events: WsExecutionEvent[]`)
 *   and direct log objects/arrays.
 * - Routes malformed frames or undecodable payloads to `options.onDecodeError` without crashing the
 *   subscription loop.
 */
export async function subscribeContractEvents<K extends ContractLogKind>(
  wsClient: SubscribeLogsWsClient,
  options: SubscribeContractEventsOptions<K>,
  onEvent: (event: DecodedContractEvent<K>) => void,
): Promise<ContractEventSubscriptionHandle> {
  if (
    !wsClient ||
    typeof wsClient !== "object" ||
    typeof wsClient.subscribeLogs !== "function" ||
    typeof wsClient.unsubscribe !== "function"
  ) {
    throw new TypeError(
      "subscribeContractEvents: wsClient must implement subscribeLogs() and unsubscribe()",
    );
  }

  if (!options || typeof options !== "object") {
    throw new TypeError("subscribeContractEvents: options must be an object");
  }

  validateContractLogKind(options.kind, "kind");

  if (typeof onEvent !== "function") {
    throw new TypeError("subscribeContractEvents: onEvent callback must be a function");
  }

  if (options.onDecodeError !== undefined && typeof options.onDecodeError !== "function") {
    throw new TypeError("subscribeContractEvents: onDecodeError must be a function when provided");
  }

  const { filter, kind, onDecodeError } = options;
  let active = true;

  const reportDecodeError = (err: unknown, rawLog: unknown): void => {
    if (!onDecodeError) {
      return;
    }
    const normalizedError = err instanceof Error ? err : new Error(String(err));
    try {
      onDecodeError(normalizedError, rawLog);
    } catch {
      // Never allow an error hook failure to crash the subscription loop
    }
  };

  const processSingleLog = (rawLog: unknown, receipt?: WsLogReceipt): void => {
    if (!active) return;

    if (!rawLog || typeof rawLog !== "object" || Array.isArray(rawLog)) {
      reportDecodeError(
        new KovanicaDecodeError(
          "INVALID_INPUT",
          "subscribeContractEvents: expected log object payload",
          { field: "rawLog" },
        ),
        rawLog,
      );
      return;
    }

    let decoded: DecodedContractLogByKind<K>;
    try {
      const rawData = (rawLog as { data?: unknown }).data;
      const bytesOrHex = toDecodableLogData(rawData, "subscribeContractEvents");
      decoded = decodeContractLog(bytesOrHex, kind);
    } catch (err: unknown) {
      reportDecodeError(err, rawLog);
      return;
    }

    const event: DecodedContractEvent<K> = {
      kind: decoded.kind,
      record: decoded.record,
      raw: rawLog as WsExecutionEvent | ContractLogEntry,
      ...(receipt !== undefined ? { receipt } : {}),
    } as DecodedContractEvent<K>;

    onEvent(event);
  };

  const handleNotification = (payload: unknown): void => {
    if (!active) return;

    if (Array.isArray(payload)) {
      for (const item of payload) {
        if (!active) return;
        if (isReceiptWithEvents(item)) {
          for (const ev of item.events) {
            if (!active) return;
            processSingleLog(ev, item);
          }
        } else {
          processSingleLog(item);
        }
      }
      return;
    }

    if (isReceiptWithEvents(payload)) {
      for (const ev of payload.events) {
        if (!active) return;
        processSingleLog(ev, payload);
      }
      return;
    }

    processSingleLog(payload);
  };

  const subscriptionId = await wsClient.subscribeLogs(
    filter,
    handleNotification as WsSubscriptionCallback<WsLogReceipt[]>,
  );

  return {
    subscriptionId,
    unsubscribe: async (): Promise<boolean> => {
      active = false;
      return wsClient.unsubscribe(subscriptionId);
    },
  };
}
