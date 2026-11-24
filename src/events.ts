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
import { parseQuantity, toHexQuantity } from "./units";
import type {
  WsExecutionEvent,
  WsLogFilter,
  WsLogReceipt,
  WsSubscriptionCallback,
} from "./ws";

/** Default maximum number of blocks queried per `kovanica_getLogs` chunk. */
export const DEFAULT_LOG_HISTORY_CHUNK_SIZE = 1_000;

/**
 * Default maximum inclusive block span per `kovanica_getLogs` chunk window
 * in {@link queryContractLogsPaginated} (matches L1 `MAX_GET_LOGS_BLOCK_RANGE = 500`).
 */
export const DEFAULT_CONTRACT_LOGS_MAX_SPAN = 500;

/** Default maximum number of `kovanica_getLogs` page requests per {@link queryContractLogsPaginated} call. */
export const DEFAULT_CONTRACT_LOGS_MAX_PAGES = 20;

/** Default page size hint (`limit`) per `kovanica_getLogs` request in {@link queryContractLogsPaginated}. */
export const DEFAULT_CONTRACT_LOGS_PAGE_LIMIT = 200;

const U64_MAX = 18_446_744_073_709_551_615n;

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
// Paginated & Max-Span-Chunked Contract Log Streamer (`queryContractLogsPaginated`)
// ============================================================================

/** Parsed `kovanica_getLogs` cursor (`"<height>:<logIndex>"`). */
export interface ContractLogCursor {
  height: bigint;
  logIndex: bigint;
}

/** RPC filter object passed to `kovanica_getLogs` by {@link queryContractLogsPaginated}. */
export interface PaginatedGetLogsRpcFilter {
  fromBlock: HexString;
  toBlock: HexString;
  address?: KovanicaAddress | ReadonlyArray<KovanicaAddress>;
  topics?: ReadonlyArray<string | ReadonlyArray<string> | null>;
  cursor?: string;
  limit?: number;
}

/** Structured paginated response envelope optionally returned by cursor-aware RPC proxies/servers. */
export interface RawPaginatedLogsPage {
  logs: ReadonlyArray<ContractLogEntry>;
  nextCursor?: string | null;
  next_cursor?: string | null;
  hasMore?: boolean;
  has_more?: boolean;
}

/** Supported `kovanica_getLogs` response shapes (standard L1 array or paginated envelope). */
export type RawGetLogsResponse = ReadonlyArray<ContractLogEntry> | RawPaginatedLogsPage;

/**
 * Minimal client interface required by {@link queryContractLogsPaginated}.
 * Satisfied by {@link KovanicaClient} (via `call("kovanica_getLogs", ...)`) or any
 * client implementing `getLogs(filter, options)`.
 */
export type PaginatedLogsClient =
  | {
      getLogs(
        filter: PaginatedGetLogsRpcFilter,
        options?: RequestOptions,
      ): Promise<RawGetLogsResponse>;
    }
  | {
      call<TResult = unknown>(
        method: string,
        params?: unknown,
        options?: RequestOptions,
      ): Promise<TResult>;
    };

/** Filter parameters for {@link queryContractLogsPaginated}. */
export interface ContractLogsQueryFilter {
  /** Inclusive start block height (non-negative `bigint` or safe integer `number`). */
  fromBlock: bigint | number;
  /** Inclusive end block height (non-negative `bigint` or safe integer `number`, must be `>= fromBlock`). */
  toBlock: bigint | number;
  /** Optional contract address or array of addresses (PRO-21 `kvnc...dag` / `tknc...dag`, 32-byte hex, or 32-byte `Uint8Array`). */
  address?: Uint8Array | string | ReadonlyArray<Uint8Array | string>;
  /** Optional positional topic filters forwarded to `kovanica_getLogs`. */
  topics?: ReadonlyArray<string | ReadonlyArray<string> | null>;
  /** Optional pagination cursor (`"<height>:<logIndex>"`) from a previous query's `nextCursor`. */
  cursor?: string;
}

/** Options for {@link queryContractLogsPaginated}. */
export interface QueryContractLogsPaginatedOptions<
  K extends ContractLogKind = ContractLogKind,
> {
  /** Optional pagination cursor (`"<height>:<logIndex>"`); overrides `filter.cursor` if both are set. */
  cursor?: string;
  /** Maximum inclusive block span per chunk window. Positive safe integer; defaults to `500`. */
  maxSpan?: number;
  /** Maximum number of `kovanica_getLogs` page requests per call. Positive safe integer; defaults to `20`. */
  maxPages?: number;
  /** Page size hint (`limit`) per `kovanica_getLogs` request. Positive safe integer; defaults to `200`. */
  pageLimit?: number;
  /** When `true`, decodes returned logs via {@link decodeContractLog} using `kind`. */
  decode?: boolean;
  /** Static {@link ContractLogKind} or resolver callback used when `decode` is enabled. */
  kind?: K | ContractLogKindResolver<K>;
  /** Optional cancellation signal checked before and between requests and forwarded to each RPC call. */
  signal?: AbortSignal;
  /** Optional per-page RPC request options (`timeoutMs`, `signal`). */
  requestOptions?: RequestOptions;
}

/** Decoded log entry produced when `decode` is enabled in {@link queryContractLogsPaginated}. */
export type DecodedPaginatedContractLog<K extends ContractLogKind = ContractLogKind> = {
  [P in K]: {
    /** 0-based index of the log inside `PaginatedContractLogsResult.logs`. */
    index: number;
    /** Contract log kind used for decoding. */
    kind: P;
    /** Decoded typed Bincode record. */
    record: DecodedContractLogByKind<P>["record"];
    /** Original raw log entry. */
    log: ContractLogEntry;
  };
}[K];

/** Result returned by {@link queryContractLogsPaginated}. */
export interface PaginatedContractLogsResult<
  K extends ContractLogKind = ContractLogKind,
> {
  /** Deduplicated raw logs collected across scanned chunks and pages. */
  logs: ContractLogEntry[];
  /** Decoded logs when `decode` is enabled; omitted otherwise. */
  decodedLogs?: Array<DecodedPaginatedContractLog<K>>;
  /** Opaque cursor (`"<height>:<logIndex>"`) for resuming pagination, or `null` when complete. */
  nextCursor: string | null;
  /** `true` if more pages or block chunks remain beyond `maxPages`; `false` otherwise. */
  hasMore: boolean;
  /** Total number of `kovanica_getLogs` page requests executed. */
  pagesFetched: number;
  /** Total number of block-range chunk windows scanned. */
  chunksScanned: number;
}

function parseCursorComponent(raw: string): bigint | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
    const hexPart = trimmed.slice(2);
    if (hexPart.length === 0 || !/^[0-9a-fA-F]+$/.test(hexPart)) {
      return null;
    }
    return BigInt(`0x${hexPart}`);
  }
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  return BigInt(trimmed);
}

/**
 * Parses a `kovanica_getLogs` pagination cursor (`"<height>:<logIndex>"`).
 * Accepts decimal integers or `0x`-prefixed hex quantities for each component.
 */
export function parseContractLogCursor(cursor: string): ContractLogCursor {
  if (typeof cursor !== "string") {
    throw new TypeError("queryContractLogsPaginated: cursor must be a '<height>:<logIndex>' string");
  }
  const trimmed = cursor.trim();
  const sep = trimmed.indexOf(":");
  if (sep === -1 || trimmed.indexOf(":", sep + 1) !== -1) {
    throw new RangeError(
      `queryContractLogsPaginated: invalid cursor "${cursor}" (expected '<height>:<logIndex>')`,
    );
  }
  const height = parseCursorComponent(trimmed.slice(0, sep));
  const logIndex = parseCursorComponent(trimmed.slice(sep + 1));
  if (height === null || logIndex === null || height < 0n || logIndex < 0n) {
    throw new RangeError(
      `queryContractLogsPaginated: invalid cursor "${cursor}" (expected non-negative '<height>:<logIndex>')`,
    );
  }
  return { height, logIndex };
}

/** Formats a canonical `kovanica_getLogs` pagination cursor (`"<height>:<logIndex>"`). */
export function formatContractLogCursor(height: bigint, logIndex: bigint): string {
  if (height < 0n || logIndex < 0n) {
    throw new RangeError("formatContractLogCursor: height and logIndex must be non-negative");
  }
  return `${height.toString(10)}:${logIndex.toString(10)}`;
}

function parseOptionalLogQuantity(value: unknown): bigint | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "boolean" || typeof value === "object" || typeof value === "symbol") {
    return null;
  }
  try {
    const parsed = parseQuantity(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

function extractLogCursor(log: ContractLogEntry): string | null {
  const height = parseOptionalLogQuantity(log.blockNumber ?? log.blockHeight);
  const logIndex = parseOptionalLogQuantity(log.logIndex);
  if (height === null || logIndex === null) {
    return null;
  }
  return formatContractLogCursor(height, logIndex);
}

function getLogDedupeKey(log: ContractLogEntry): string | null {
  const height = parseOptionalLogQuantity(log.blockNumber ?? log.blockHeight);
  const logIndex = parseOptionalLogQuantity(log.logIndex);
  if (height !== null && logIndex !== null) {
    return `bh:${height.toString(10)}:${logIndex.toString(10)}`;
  }
  if (typeof log.transactionHash === "string" && log.transactionHash.trim().length > 0 && logIndex !== null) {
    return `tx:${log.transactionHash.trim().toLowerCase()}:${logIndex.toString(10)}`;
  }
  return null;
}

function normalizeServerCursor(rawCursor: string): string {
  const trimmed = rawCursor.trim();
  try {
    const parsed = parseContractLogCursor(trimmed);
    return formatContractLogCursor(parsed.height, parsed.logIndex);
  } catch {
    return trimmed;
  }
}

function normalizeAddressFilter(
  address: Uint8Array | string | ReadonlyArray<Uint8Array | string> | undefined,
): KovanicaAddress | ReadonlyArray<KovanicaAddress> | undefined {
  if (address === undefined) {
    return undefined;
  }
  if (Array.isArray(address)) {
    return address.map((entry, idx) => {
      if (typeof entry !== "string" && !(entry instanceof Uint8Array)) {
        throw new TypeError(
          `queryContractLogsPaginated: address[${idx}] must be a PRO-21 address, 32-byte hex string, or 32-byte Uint8Array`,
        );
      }
      return normalizeOptionalContractAddress(entry)!;
    });
  }
  if (typeof address !== "string" && !(address instanceof Uint8Array)) {
    throw new TypeError(
      "queryContractLogsPaginated: address must be a PRO-21 address, 32-byte hex string, 32-byte Uint8Array, or array of addresses",
    );
  }
  return normalizeOptionalContractAddress(address);
}

async function fetchPaginatedLogsPage(
  client: PaginatedLogsClient,
  filter: PaginatedGetLogsRpcFilter,
  requestOptions: RequestOptions | undefined,
): Promise<RawGetLogsResponse> {
  const candidate = client as {
    getLogs?: (
      filter: PaginatedGetLogsRpcFilter,
      options?: RequestOptions,
    ) => Promise<RawGetLogsResponse>;
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
    return candidate.call<RawGetLogsResponse>("kovanica_getLogs", [filter], requestOptions);
  }
  throw new TypeError("queryContractLogsPaginated: client must implement getLogs() or call()");
}

function parseRawGetLogsResponse(
  raw: RawGetLogsResponse,
  pageNumber: number,
): {
  pageLogs: ReadonlyArray<ContractLogEntry>;
  explicitNextCursor: string | null;
  isStructuredEnvelope: boolean;
} {
  if (Array.isArray(raw)) {
    return {
      pageLogs: raw,
      explicitNextCursor: null,
      isStructuredEnvelope: false,
    };
  }
  if (raw && typeof raw === "object") {
    const page = raw as RawPaginatedLogsPage;
    if (!Array.isArray(page.logs)) {
      throw new KovanicaDecodeError(
        "INVALID_INPUT",
        `kovanica_getLogs: expected page ${pageNumber} logs to be an array`,
        { field: "logs" },
      );
    }
    const rawNext = page.nextCursor !== undefined ? page.nextCursor : page.next_cursor;
    if (rawNext !== undefined && rawNext !== null && typeof rawNext !== "string") {
      throw new TypeError(
        `queryContractLogsPaginated: expected page ${pageNumber} nextCursor to be a string or null`,
      );
    }
    const explicitNextCursor =
      typeof rawNext === "string" && rawNext.trim().length > 0 ? rawNext.trim() : null;
    return {
      pageLogs: page.logs,
      explicitNextCursor,
      isStructuredEnvelope: true,
    };
  }
  throw new KovanicaDecodeError(
    "INVALID_INPUT",
    `kovanica_getLogs: expected page ${pageNumber} response to be an array or paginated object`,
    { field: "logs" },
  );
}

/**
 * Queries contract logs across an arbitrary `[fromBlock, toBlock]` range by automatically
 * chunking wide ranges into `<= maxSpan` windows and walking cursor-paginated pages within
 * each chunk up to `maxPages`.
 *
 * - Validates all inputs fail-closed before any RPC I/O.
 * - Deduplicates logs across chunk and cursor boundaries by `(blockHeight, logIndex)` (or `(txHash, logIndex)`).
 * - Guards against infinite loops from cyclic or repeated cursors.
 * - Honors `AbortSignal` before and between page requests and forwards it to the RPC client.
 * - Optionally decodes collected logs via {@link decodeContractLog} when `options.decode` is enabled.
 */
export async function queryContractLogsPaginated<K extends ContractLogKind>(
  client: PaginatedLogsClient,
  filter: ContractLogsQueryFilter,
  options: QueryContractLogsPaginatedOptions<K> & {
    decode: true;
    kind: K | ContractLogKindResolver<K>;
  },
): Promise<
  PaginatedContractLogsResult<K> & {
    decodedLogs: Array<DecodedPaginatedContractLog<K>>;
  }
>;
export async function queryContractLogsPaginated<K extends ContractLogKind = ContractLogKind>(
  client: PaginatedLogsClient,
  filter: ContractLogsQueryFilter,
  options?: QueryContractLogsPaginatedOptions<K>,
): Promise<PaginatedContractLogsResult<K>>;
export async function queryContractLogsPaginated<K extends ContractLogKind = ContractLogKind>(
  client: PaginatedLogsClient,
  filter: ContractLogsQueryFilter,
  options?: QueryContractLogsPaginatedOptions<K>,
): Promise<PaginatedContractLogsResult<K>> {
  if (
    !client ||
    typeof client !== "object" ||
    (typeof (client as { getLogs?: unknown }).getLogs !== "function" &&
      typeof (client as { call?: unknown }).call !== "function")
  ) {
    throw new TypeError("queryContractLogsPaginated: client must implement getLogs() or call()");
  }

  if (!filter || typeof filter !== "object") {
    throw new TypeError("queryContractLogsPaginated: filter must be an object");
  }

  if (options !== undefined && (!options || typeof options !== "object")) {
    throw new TypeError("queryContractLogsPaginated: options must be an object when provided");
  }

  const fromBlock = parseNonNegativeBlockNumber(filter.fromBlock, "fromBlock");
  const toBlock = parseNonNegativeBlockNumber(filter.toBlock, "toBlock");
  if (fromBlock > toBlock) {
    throw new RangeError(
      `queryContractLogsPaginated: fromBlock (${fromBlock}) must be <= toBlock (${toBlock})`,
    );
  }

  const maxSpan = options?.maxSpan ?? DEFAULT_CONTRACT_LOGS_MAX_SPAN;
  if (typeof maxSpan !== "number" || !Number.isSafeInteger(maxSpan) || maxSpan < 1) {
    throw new RangeError(
      `queryContractLogsPaginated: maxSpan must be a positive safe integer (>= 1), got ${String(maxSpan)}`,
    );
  }

  const maxPages = options?.maxPages ?? DEFAULT_CONTRACT_LOGS_MAX_PAGES;
  if (typeof maxPages !== "number" || !Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new RangeError(
      `queryContractLogsPaginated: maxPages must be a positive safe integer (>= 1), got ${String(maxPages)}`,
    );
  }

  const pageLimit = options?.pageLimit ?? DEFAULT_CONTRACT_LOGS_PAGE_LIMIT;
  if (typeof pageLimit !== "number" || !Number.isSafeInteger(pageLimit) || pageLimit < 1) {
    throw new RangeError(
      `queryContractLogsPaginated: pageLimit must be a positive safe integer (>= 1), got ${String(pageLimit)}`,
    );
  }

  const normalizedAddress = normalizeAddressFilter(filter.address);

  if (filter.topics !== undefined && !Array.isArray(filter.topics)) {
    throw new TypeError("queryContractLogsPaginated: topics must be an array when provided");
  }

  if (options?.decode !== undefined && typeof options.decode !== "boolean") {
    throw new TypeError("queryContractLogsPaginated: decode must be a boolean when provided");
  }

  const shouldDecode = options?.decode ?? options?.kind !== undefined;
  if (shouldDecode && options?.kind === undefined) {
    throw new TypeError(
      "queryContractLogsPaginated: options.kind is required when decode is enabled",
    );
  }
  if (options?.kind !== undefined && typeof options.kind !== "function") {
    validateContractLogKind(options.kind, "kind");
  }

  const rawInitialCursor = options?.cursor ?? filter.cursor;
  const parsedInitialCursor =
    rawInitialCursor !== undefined ? parseContractLogCursor(rawInitialCursor) : null;

  const isAborted = (): boolean =>
    Boolean(options?.signal?.aborted || options?.requestOptions?.signal?.aborted);

  if (isAborted()) {
    throw new KovanicaAbortError("Paginated contract log query was aborted");
  }

  let chunkStart = fromBlock;
  let currentCursor: string | undefined;
  if (parsedInitialCursor !== null) {
    if (parsedInitialCursor.logIndex === U64_MAX) {
      const resumeHeight = parsedInitialCursor.height + 1n;
      if (resumeHeight > chunkStart) {
        chunkStart = resumeHeight;
      }
      currentCursor = undefined;
    } else {
      if (parsedInitialCursor.height > chunkStart) {
        chunkStart = parsedInitialCursor.height;
      }
      currentCursor = formatContractLogCursor(
        parsedInitialCursor.height,
        parsedInitialCursor.logIndex,
      );
    }
  }

  if (chunkStart > toBlock) {
    return {
      logs: [],
      ...(shouldDecode ? { decodedLogs: [] } : {}),
      nextCursor: null,
      hasMore: false,
      pagesFetched: 0,
      chunksScanned: 0,
    };
  }

  const { options: pageRequestOptions, cleanup } = createCombinedRequestOptions(
    options?.signal,
    options?.requestOptions,
  );

  const logs: ContractLogEntry[] = [];
  const seenLogKeys = new Set<string>();
  const seenCursors = new Set<string>();
  if (currentCursor !== undefined) {
    seenCursors.add(currentCursor);
  }

  const spanStep = BigInt(maxSpan);
  let pagesFetched = 0;
  let chunksScanned = 0;
  let nextCursor: string | null = null;
  let hasMore = false;
  let stopPagination = false;

  try {
    while (chunkStart <= toBlock && pagesFetched < maxPages && !stopPagination) {
      const candidateEnd = chunkStart + spanStep - 1n;
      const chunkEnd = candidateEnd < toBlock ? candidateEnd : toBlock;
      let chunkEntered = false;
      let chunkCompleted = false;
      let lastChunkLogCursor: string | null = null;

      while (pagesFetched < maxPages) {
        if (isAborted()) {
          throw new KovanicaAbortError("Paginated contract log query was aborted");
        }

        const rpcFilter: PaginatedGetLogsRpcFilter = {
          fromBlock: toHexQuantity(chunkStart),
          toBlock: toHexQuantity(chunkEnd),
          ...(normalizedAddress !== undefined ? { address: normalizedAddress } : {}),
          ...(filter.topics !== undefined ? { topics: filter.topics } : {}),
          ...(currentCursor !== undefined ? { cursor: currentCursor } : {}),
          limit: pageLimit,
        };

        const rawPage = await fetchPaginatedLogsPage(client, rpcFilter, pageRequestOptions);
        pagesFetched += 1;
        if (!chunkEntered) {
          chunkEntered = true;
          chunksScanned += 1;
        }

        const { pageLogs, explicitNextCursor, isStructuredEnvelope } = parseRawGetLogsResponse(
          rawPage,
          pagesFetched,
        );

        for (let i = 0; i < pageLogs.length; i += 1) {
          const entry = pageLogs[i]!;
          if (!entry || typeof entry !== "object") {
            throw new KovanicaDecodeError(
              "INVALID_INPUT",
              `queryContractLogsPaginated: invalid log entry at page ${pagesFetched}[${i}]`,
              { field: `logs[${i}]` },
            );
          }
          const dedupeKey = getLogDedupeKey(entry);
          if (dedupeKey === null || !seenLogKeys.has(dedupeKey)) {
            if (dedupeKey !== null) {
              seenLogKeys.add(dedupeKey);
            }
            logs.push(entry);
          }
          const entryCursor = extractLogCursor(entry);
          if (entryCursor !== null) {
            lastChunkLogCursor = entryCursor;
          }
        }

        let candidateNextCursor: string | null = null;
        if (explicitNextCursor !== null) {
          candidateNextCursor = normalizeServerCursor(explicitNextCursor);
        } else if (
          !isStructuredEnvelope &&
          pageLogs.length === pageLimit &&
          lastChunkLogCursor !== null
        ) {
          candidateNextCursor = lastChunkLogCursor;
        }

        if (candidateNextCursor !== null) {
          // Guard against infinite loops caused by repeated or cyclic cursors.
          if (seenCursors.has(candidateNextCursor)) {
            nextCursor = null;
            hasMore = false;
            stopPagination = true;
            break;
          }

          if (pagesFetched >= maxPages) {
            nextCursor = candidateNextCursor;
            hasMore = true;
            stopPagination = true;
            break;
          }

          seenCursors.add(candidateNextCursor);
          currentCursor = candidateNextCursor;
          continue;
        }

        chunkCompleted = true;
        currentCursor = undefined;
        break;
      }

      if (stopPagination) {
        break;
      }

      if (chunkCompleted) {
        if (chunkEnd < toBlock) {
          if (pagesFetched >= maxPages) {
            nextCursor = formatContractLogCursor(chunkEnd, U64_MAX);
            hasMore = true;
            break;
          }
          chunkStart = chunkEnd + 1n;
        } else {
          nextCursor = null;
          hasMore = false;
          break;
        }
      }
    }
  } finally {
    cleanup();
  }

  if (isAborted()) {
    throw new KovanicaAbortError("Paginated contract log query was aborted");
  }

  let decodedLogs: Array<DecodedPaginatedContractLog<K>> | undefined;
  if (shouldDecode && options?.kind !== undefined) {
    decodedLogs = [];
    const kindOrResolver = options.kind;
    for (let i = 0; i < logs.length; i += 1) {
      const log = logs[i]!;
      const normalizedLog = normalizeLogForDecoding(log, i);
      const resolvedKind =
        typeof kindOrResolver === "function" ? kindOrResolver(normalizedLog, i) : kindOrResolver;
      if (resolvedKind === null || resolvedKind === undefined) {
        continue;
      }
      validateContractLogKind(resolvedKind, `logs[${i}].kind`);
      const decoded = decodeContractLog(normalizedLog.data, resolvedKind);
      decodedLogs.push({
        index: i,
        kind: decoded.kind,
        record: decoded.record,
        log,
      } as DecodedPaginatedContractLog<K>);
    }
  }

  return {
    logs,
    ...(decodedLogs !== undefined ? { decodedLogs } : {}),
    nextCursor,
    hasMore,
    pagesFetched,
    chunksScanned,
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
