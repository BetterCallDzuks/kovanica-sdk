/**
 * Paginated Account Transaction History (`kovanica_getTransactionHistory`).
 *
 * Fetches newest-first committed transactions touching an account address using
 * cursor-based pagination, with lossless `bigint` parsing for amounts, fees,
 * heights, and timestamps, bounded page limits (`maxPages`), duplicate/cyclic
 * cursor loop protection, and `AbortSignal` cancellation.
 */

import { KovanicaAbortError } from "./errors";
import type { HexString, KovanicaAddress, RequestOptions } from "./types";
import { parseQuantity } from "./units";

/** Default page size used by `kovanica_getTransactionHistory` on L1 nodes. */
export const DEFAULT_ACCOUNT_TX_HISTORY_LIMIT = 20;

/** Maximum page size enforced by L1 nodes (values above 100 are clamped server-side). */
export const MAX_ACCOUNT_TX_HISTORY_LIMIT = 100;

/** Default maximum number of sequential pages fetched by {@link getAccountTxHistory}. */
export const DEFAULT_ACCOUNT_TX_HISTORY_MAX_PAGES = 10;

/** Direction filter accepted by `kovanica_getTransactionHistory`. */
export type AccountTxDirection = "all" | "sent" | "received";

/** Execution status of a committed transaction history entry. */
export type AccountTxStatus = "success" | "failed";

const VALID_DIRECTIONS: ReadonlySet<AccountTxDirection> = new Set<AccountTxDirection>([
  "all",
  "sent",
  "received",
]);

/** Raw JSON-RPC entry returned inside `kovanica_getTransactionHistory` `entries`. */
export interface RawAccountTxHistoryEntry {
  hash: string;
  height: string | number | bigint;
  timestamp?: string | number | bigint | null;
  from: string;
  to?: string | null;
  amount: string | number | bigint;
  fee: string | number | bigint;
  kind: string;
  status: string;
}

/** Raw JSON-RPC page returned by `kovanica_getTransactionHistory`. */
export interface RawAccountTxHistoryPage {
  entries?: ReadonlyArray<RawAccountTxHistoryEntry> | null;
  next_cursor?: string | null;
  /** Optional camelCase alias tolerated from mock or proxy servers. */
  nextCursor?: string | null;
}

/** Parsed, lossless account transaction history entry. */
export interface AccountTxHistoryEntry {
  /** Transaction hash (`0x...`). */
  hash: HexString;
  /** Committed leader height at which the transaction was executed. */
  height: bigint;
  /** Leader-header producer timestamp, or `null` when unavailable / placeholder `0`. */
  timestamp: bigint | null;
  /** Sender address. */
  from: KovanicaAddress;
  /** Recipient address, or `null` for non-recipient transaction kinds (e.g. `stake`). */
  to: KovanicaAddress | null;
  /** Transaction amount in atomic units (atoms); `0n` when the kind has no KVNC amount. */
  amount: bigint;
  /** Transaction fee paid in atomic units (atoms). */
  fee: bigint;
  /** Transaction kind label reported by the node (e.g. `"transfer"`, `"stake"`, `"call"`). */
  kind: string;
  /** Execution outcome (`"success"` or `"failed"`). */
  status: AccountTxStatus;
}

/** Parameter object sent to `kovanica_getTransactionHistory`. */
export interface GetTransactionHistoryParams {
  address: KovanicaAddress;
  limit?: number;
  cursor?: string;
  direction?: AccountTxDirection;
}

/**
 * Minimal client interface required by {@link getAccountTxHistory}.
 * Satisfied by {@link KovanicaClient} (via `call("kovanica_getTransactionHistory", ...)`)
 * or any client implementing `getTransactionHistory(params, options)`.
 */
export type AccountTxHistoryClient =
  | {
      getTransactionHistory(
        params: GetTransactionHistoryParams,
        options?: RequestOptions,
      ): Promise<RawAccountTxHistoryPage>;
    }
  | {
      call<TResult = unknown>(
        method: string,
        params?: unknown,
        options?: RequestOptions,
      ): Promise<TResult>;
    };

/** Options for {@link getAccountTxHistory}. */
export interface GetAccountTxHistoryOptions {
  /** Account address (`kvnc...dag` / `tknc...dag` or 32-byte hex string). */
  address: KovanicaAddress;
  /** Optional direction filter (`"all"`, `"sent"`, or `"received"`). */
  direction?: AccountTxDirection;
  /** Optional page size per RPC call (non-negative safe integer). */
  limit?: number;
  /** Maximum number of sequential pages to fetch. Positive safe integer; defaults to `10`. */
  maxPages?: number;
  /** Optional opaque pagination cursor from a previous `nextCursor`. */
  cursor?: string;
  /** Optional cancellation signal checked before each page and forwarded to RPC calls. */
  signal?: AbortSignal;
  /** Optional per-page RPC request options (`timeoutMs`, `signal`). */
  requestOptions?: RequestOptions;
}

/** Paginated result returned by {@link getAccountTxHistory}. */
export interface AccountTxHistoryResult {
  /** Parsed transaction history entries collected across fetched pages (newest-first). */
  items: AccountTxHistoryEntry[];
  /** Opaque cursor for fetching the next page, or `null` when pagination is complete. */
  nextCursor: string | null;
  /** `true` if the node reported more pages beyond `maxPages`; `false` otherwise. */
  hasMore: boolean;
  /** Number of `kovanica_getTransactionHistory` pages fetched. */
  pagesFetched: number;
}

function createCombinedRequestOptions(
  signal: AbortSignal | undefined,
  requestOptions: RequestOptions | undefined,
): { options: RequestOptions | undefined; cleanup: () => void } {
  const reqSignal = requestOptions?.signal;
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

/**
 * Losslessly parse a raw `kovanica_getTransactionHistory` entry into an {@link AccountTxHistoryEntry}.
 *
 * Parses `height`, `timestamp` (when non-null), `amount`, and `fee` via {@link parseQuantity}
 * so hex strings, decimal strings, safe integers, and `bigint` values are converted losslessly.
 */
export function parseAccountTxHistoryEntry(
  raw: RawAccountTxHistoryEntry,
  index?: number,
): AccountTxHistoryEntry {
  const label = index === undefined ? "entry" : `entries[${index}]`;
  if (!raw || typeof raw !== "object") {
    throw new TypeError(`getAccountTxHistory: invalid ${label}; expected an object`);
  }
  if (typeof raw.hash !== "string" || raw.hash.trim().length === 0) {
    throw new TypeError(`getAccountTxHistory: ${label}.hash must be a non-empty string`);
  }
  if (typeof raw.from !== "string" || raw.from.trim().length === 0) {
    throw new TypeError(`getAccountTxHistory: ${label}.from must be a non-empty string`);
  }
  if (raw.to !== null && raw.to !== undefined && typeof raw.to !== "string") {
    throw new TypeError(`getAccountTxHistory: ${label}.to must be a string or null`);
  }
  if (typeof raw.kind !== "string" || raw.kind.trim().length === 0) {
    throw new TypeError(`getAccountTxHistory: ${label}.kind must be a non-empty string`);
  }
  if (raw.status !== "success" && raw.status !== "failed") {
    throw new TypeError(
      `getAccountTxHistory: ${label}.status must be "success" or "failed", got ${String(raw.status)}`,
    );
  }

  const height = parseQuantity(raw.height);
  const timestamp =
    raw.timestamp === null || raw.timestamp === undefined
      ? null
      : parseQuantity(raw.timestamp);
  const amount = parseQuantity(raw.amount);
  const fee = parseQuantity(raw.fee);

  return {
    hash: raw.hash,
    height,
    timestamp,
    from: raw.from,
    to: raw.to ?? null,
    amount,
    fee,
    kind: raw.kind,
    status: raw.status,
  };
}

async function fetchHistoryPage(
  client: AccountTxHistoryClient,
  params: GetTransactionHistoryParams,
  requestOptions: RequestOptions | undefined,
): Promise<RawAccountTxHistoryPage> {
  const candidate = client as {
    getTransactionHistory?: (
      params: GetTransactionHistoryParams,
      options?: RequestOptions,
    ) => Promise<RawAccountTxHistoryPage>;
    call?: <TResult = unknown>(
      method: string,
      params?: unknown,
      options?: RequestOptions,
    ) => Promise<TResult>;
  };

  if (typeof candidate.getTransactionHistory === "function") {
    return candidate.getTransactionHistory(params, requestOptions);
  }
  if (typeof candidate.call === "function") {
    return candidate.call<RawAccountTxHistoryPage>(
      "kovanica_getTransactionHistory",
      [params],
      requestOptions,
    );
  }
  throw new TypeError(
    "getAccountTxHistory: client must implement getTransactionHistory() or call()",
  );
}

/**
 * Fetches paginated account transaction history from `kovanica_getTransactionHistory`.
 *
 * - Walks cursor-based pages sequentially up to `maxPages` (default `10`).
 * - Guards against infinite pagination loops if a server repeats a previously seen cursor.
 * - Losslessly parses `amount`, `fee`, `height`, and `timestamp` into `bigint`.
 * - Honors `AbortSignal` before each page request and forwards it to the RPC client.
 */
export async function getAccountTxHistory(
  client: AccountTxHistoryClient,
  options: GetAccountTxHistoryOptions,
): Promise<AccountTxHistoryResult> {
  if (
    !client ||
    typeof client !== "object" ||
    (typeof (client as { getTransactionHistory?: unknown }).getTransactionHistory !== "function" &&
      typeof (client as { call?: unknown }).call !== "function")
  ) {
    throw new TypeError(
      "getAccountTxHistory: client must implement getTransactionHistory() or call()",
    );
  }

  if (!options || typeof options !== "object") {
    throw new TypeError("getAccountTxHistory: options must be an object");
  }

  if (typeof options.address !== "string" || options.address.trim().length === 0) {
    throw new TypeError("getAccountTxHistory: address must be a non-empty string");
  }
  const address = options.address.trim();

  if (options.direction !== undefined && !VALID_DIRECTIONS.has(options.direction)) {
    throw new RangeError(
      `getAccountTxHistory: direction must be "all", "sent", or "received", got ${String(options.direction)}`,
    );
  }

  if (
    options.limit !== undefined &&
    (typeof options.limit !== "number" ||
      !Number.isSafeInteger(options.limit) ||
      options.limit < 0)
  ) {
    throw new RangeError(
      `getAccountTxHistory: limit must be a non-negative safe integer, got ${String(options.limit)}`,
    );
  }

  const maxPages = options.maxPages ?? DEFAULT_ACCOUNT_TX_HISTORY_MAX_PAGES;
  if (typeof maxPages !== "number" || !Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new RangeError(
      `getAccountTxHistory: maxPages must be a positive safe integer, got ${String(maxPages)}`,
    );
  }

  if (
    options.cursor !== undefined &&
    (typeof options.cursor !== "string" || options.cursor.trim().length === 0)
  ) {
    throw new TypeError("getAccountTxHistory: cursor must be a non-empty string");
  }

  const items: AccountTxHistoryEntry[] = [];
  const seenCursors = new Set<string>();
  let currentCursor: string | undefined = options.cursor;
  if (currentCursor !== undefined) {
    seenCursors.add(currentCursor);
  }

  let pagesFetched = 0;
  let nextCursor: string | null = null;
  let hasMore = false;

  while (pagesFetched < maxPages) {
    if (options.signal?.aborted || options.requestOptions?.signal?.aborted) {
      throw new KovanicaAbortError("getAccountTxHistory: aborted before page fetch");
    }

    const params: GetTransactionHistoryParams = {
      address,
      ...(options.direction !== undefined ? { direction: options.direction } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(currentCursor !== undefined ? { cursor: currentCursor } : {}),
    };

    const { options: callOptions, cleanup } = createCombinedRequestOptions(
      options.signal,
      options.requestOptions,
    );

    let page: RawAccountTxHistoryPage;
    try {
      page = await fetchHistoryPage(client, params, callOptions);
    } finally {
      cleanup();
    }

    pagesFetched += 1;

    if (!page || typeof page !== "object") {
      throw new TypeError(
        `getAccountTxHistory: expected page ${pagesFetched} response to be an object`,
      );
    }

    const rawEntries = page.entries ?? [];
    if (!Array.isArray(rawEntries)) {
      throw new TypeError(
        `getAccountTxHistory: expected page ${pagesFetched} entries to be an array`,
      );
    }

    for (let i = 0; i < rawEntries.length; i += 1) {
      items.push(parseAccountTxHistoryEntry(rawEntries[i], i));
    }

    const rawNext = page.next_cursor !== undefined ? page.next_cursor : page.nextCursor;
    if (rawNext === null || rawNext === undefined || rawNext === "") {
      nextCursor = null;
      hasMore = false;
      break;
    }

    if (typeof rawNext !== "string") {
      throw new TypeError(
        `getAccountTxHistory: expected page ${pagesFetched} next_cursor to be a string or null`,
      );
    }

    // Guard against infinite loops caused by repeated or cyclic cursors.
    if (seenCursors.has(rawNext)) {
      nextCursor = null;
      hasMore = false;
      break;
    }

    if (pagesFetched >= maxPages) {
      nextCursor = rawNext;
      hasMore = true;
      break;
    }

    seenCursors.add(rawNext);
    currentCursor = rawNext;
  }

  return {
    items,
    nextCursor,
    hasMore,
    pagesFetched,
  };
}
