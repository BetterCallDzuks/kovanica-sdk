/**
 * JSON-RPC HTTP transport implementation for Kovanica.
 */

import {
  KovanicaAbortError,
  KovanicaRpcError,
  KovanicaTimeoutError,
  KovanicaTransportError,
} from "./errors";
import type {
  JsonRpcBatchItemResult,
  JsonRpcBatchRequestItem,
  JsonRpcRequest,
  JsonRpcResponse,
  RequestOptions,
} from "./types";

/**
 * Maximum number of JSON-RPC 2.0 requests permitted in a single batch call.
 * Matches the bounded batch limit enforced by `kovanica-rpc`.
 */
export const MAX_JSONRPC_BATCH_SIZE = 32;

/**
 * Validates a JSON-RPC 2.0 batch request array fail-closed before any network I/O.
 */
export function validateJsonRpcBatchRequests(
  requests: ReadonlyArray<JsonRpcBatchRequestItem>,
): void {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new RangeError("JSON-RPC batch must contain at least 1 request");
  }
  if (requests.length > MAX_JSONRPC_BATCH_SIZE) {
    throw new RangeError(
      `JSON-RPC batch size (${requests.length}) exceeds maximum of ${MAX_JSONRPC_BATCH_SIZE}`,
    );
  }
  for (let i = 0; i < requests.length; i++) {
    const item = requests[i];
    if (!item || typeof item.method !== "string" || item.method.trim().length === 0) {
      throw new TypeError(
        `JSON-RPC batch request at index ${i} must have a non-empty string method`,
      );
    }
  }
}

export interface Transport {
  send<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<TResult>;
  sendBatch?<TResult = unknown>(
    requests: ReadonlyArray<JsonRpcBatchRequestItem>,
    options?: RequestOptions,
  ): Promise<Array<JsonRpcBatchItemResult<TResult>>>;
}

export interface HttpTransportOptions {
  /** Full URL of the JSON-RPC endpoint (e.g. "http://127.0.0.1:8545/rpc"). */
  url: string;
  /** Custom HTTP headers sent with every request. */
  headers?: Record<string, string>;
  /** Default timeout in milliseconds for all requests. Default: 10_000ms. */
  timeoutMs?: number;
  /** Custom fetch implementation (useful for tests or custom proxies). */
  fetch?: typeof fetch;
  /** Custom ID generator. */
  requestIdGenerator?: () => number | string;
}

/**
 * Losslessly parse JSON text containing large unquoted integers that would otherwise
 * exceed JavaScript IEEE-754 Number.MAX_SAFE_INTEGER and suffer precision corruption.
 * Integers exceeding safe bounds (> 9007199254740991 or < -9007199254740991) are converted
 * to strings prior to JSON parsing so downstream parseQuantity can parse them to bigint.
 */
export function parseLosslessJson(text: string): unknown {
  const safeText = text.replace(
    /("(?:\\.|[^"\\])*")|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g,
    (_match, stringLiteral, numberLiteral) => {
      if (stringLiteral !== undefined) {
        return stringLiteral;
      }
      if (
        numberLiteral &&
        !numberLiteral.includes(".") &&
        !numberLiteral.includes("e") &&
        !numberLiteral.includes("E")
      ) {
        try {
          const b = BigInt(numberLiteral);
          if (b > 9007199254740991n || b < -9007199254740991n) {
            return `"${numberLiteral}"`;
          }
        } catch {
          // not a valid bigint, leave as is
        }
      }
      return numberLiteral;
    },
  );
  return JSON.parse(safeText);
}

/**
 * Redact sensitive credentials (tokens, passwords, basic/bearer auth) from diagnostics.
 */
export function sanitizeDiagnostics(text: string, maxLen = 500): string {
  if (!text) return "";
  let sanitized = text
    .replace(/:\/\/([^:]+):([^@]+)@/g, "://$1:***@")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1***")
    .replace(/(Basic\s+)[A-Za-z0-9+/=]+/gi, "$1***")
    .replace(/(password|secret|token|api_?key)=([^&\s"']+)/gi, "$1=***");
  if (sanitized.length > maxLen) {
    sanitized = sanitized.slice(0, maxLen) + "...";
  }
  return sanitized;
}

export class HttpTransport implements Transport {
  readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly defaultTimeoutMs: number;
  private readonly customFetch: typeof fetch;
  private idCounter = 1;
  private readonly requestIdGenerator?: () => number | string;

  constructor(options: HttpTransportOptions) {
    if (!options.url || options.url.trim().length === 0) {
      throw new Error("HTTP transport requires a non-empty RPC url");
    }
    this.url = options.url.trim();
    this.headers = {
      "Content-Type": "application/json",
      ...options.headers,
    };
    this.defaultTimeoutMs = options.timeoutMs ?? 10_000;
    this.customFetch = options.fetch ?? globalThis.fetch;
    this.requestIdGenerator = options.requestIdGenerator;
  }

  private nextId(): number | string {
    if (this.requestIdGenerator) {
      return this.requestIdGenerator();
    }
    return this.idCounter++;
  }

  async send<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<TResult> {
    const id = this.nextId();
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      id,
    };
    if (params !== undefined) {
      req.params = params;
    }

    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    let isTimedOut = false;

    const timer = setTimeout(() => {
      isTimedOut = true;
      controller.abort();
    }, timeoutMs);

    let removeUserSignalListener: (() => void) | undefined;
    if (options?.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        throw new KovanicaAbortError("Request was already aborted");
      }
      const onUserAbort = () => {
        controller.abort();
      };
      options.signal.addEventListener("abort", onUserAbort, { once: true });
      removeUserSignalListener = () => {
        options.signal?.removeEventListener("abort", onUserAbort);
      };
    }

    try {
      const response = await this.customFetch(this.url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(req),
        signal: controller.signal,
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        const sanitizedBody = sanitizeDiagnostics(bodyText);
        throw new KovanicaTransportError(
          `HTTP ${response.status} ${response.statusText}${sanitizedBody ? `: ${sanitizedBody}` : ""}`,
          { status: response.status, statusText: response.statusText },
        );
      }

      let parsed: unknown;
      try {
        if (typeof response.text === "function") {
          const text = await response.text();
          parsed = parseLosslessJson(text);
        } else {
          parsed = await response.json();
        }
      } catch (err) {
        throw new KovanicaTransportError("Malformed JSON response from RPC server", {
          cause: err,
        });
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new KovanicaTransportError(
          "Invalid JSON-RPC 2.0 response: payload must be a JSON object",
        );
      }

      const rpcRes = parsed as Partial<JsonRpcResponse<TResult>>;

      if (rpcRes.jsonrpc !== "2.0") {
        throw new KovanicaTransportError(
          `Invalid JSON-RPC 2.0 response: missing or invalid "jsonrpc" version (expected "2.0", got "${rpcRes.jsonrpc}")`,
        );
      }

      if (rpcRes.result === undefined && rpcRes.error === undefined) {
        throw new KovanicaTransportError(
          "Invalid JSON-RPC 2.0 response: neither result nor error member present",
        );
      }

      if (rpcRes.result !== undefined && rpcRes.error !== undefined) {
        throw new KovanicaTransportError(
          "Invalid JSON-RPC 2.0 response: both result and error members present",
        );
      }

      if (rpcRes.id !== req.id) {
        if (!(rpcRes.error && rpcRes.id === null)) {
          throw new KovanicaTransportError(
            `JSON-RPC response ID mismatch: expected ${req.id}, got ${rpcRes.id}`,
          );
        }
      }

      if (rpcRes.error) {
        if (
          typeof rpcRes.error !== "object" ||
          typeof rpcRes.error.code !== "number" ||
          typeof rpcRes.error.message !== "string"
        ) {
          throw new KovanicaTransportError(
            "Invalid JSON-RPC 2.0 response: malformed error object",
          );
        }
        throw new KovanicaRpcError(
          rpcRes.error.code,
          rpcRes.error.message,
          rpcRes.error.data,
        );
      }

      return rpcRes.result as TResult;
    } catch (err: unknown) {
      if (isTimedOut) {
        throw new KovanicaTimeoutError(timeoutMs);
      }
      if (options?.signal?.aborted) {
        throw new KovanicaAbortError("Request was cancelled by user");
      }
      if (
        err instanceof KovanicaRpcError ||
        err instanceof KovanicaTransportError
      ) {
        throw err;
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new KovanicaAbortError("Request was aborted");
      }
      throw new KovanicaTransportError(
        sanitizeDiagnostics(err instanceof Error ? err.message : String(err)),
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
      if (removeUserSignalListener) {
        removeUserSignalListener();
      }
    }
  }

  async sendBatch<TResult = unknown>(
    requests: ReadonlyArray<JsonRpcBatchRequestItem>,
    options?: RequestOptions,
  ): Promise<Array<JsonRpcBatchItemResult<TResult>>> {
    validateJsonRpcBatchRequests(requests);

    const idToIndex = new Map<string | number, number>();
    const payload: JsonRpcRequest[] = requests.map((item, index) => {
      const id = this.nextId();
      if (idToIndex.has(id)) {
        throw new KovanicaTransportError(
          `Duplicate JSON-RPC request ID generated in batch: ${String(id)}`,
        );
      }
      idToIndex.set(id, index);

      const req: JsonRpcRequest = {
        jsonrpc: "2.0",
        method: item.method,
        id,
      };
      if (item.params !== undefined) {
        req.params = item.params;
      }
      return req;
    });

    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    let isTimedOut = false;

    const timer = setTimeout(() => {
      isTimedOut = true;
      controller.abort();
    }, timeoutMs);

    let removeUserSignalListener: (() => void) | undefined;
    if (options?.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        throw new KovanicaAbortError("Request was already aborted");
      }
      const onUserAbort = () => {
        controller.abort();
      };
      options.signal.addEventListener("abort", onUserAbort, { once: true });
      removeUserSignalListener = () => {
        options.signal?.removeEventListener("abort", onUserAbort);
      };
    }

    try {
      const response = await this.customFetch(this.url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        const sanitizedBody = sanitizeDiagnostics(bodyText);
        throw new KovanicaTransportError(
          `HTTP ${response.status} ${response.statusText}${sanitizedBody ? `: ${sanitizedBody}` : ""}`,
          { status: response.status, statusText: response.statusText },
        );
      }

      let parsed: unknown;
      try {
        if (typeof response.text === "function") {
          const text = await response.text();
          parsed = parseLosslessJson(text);
        } else {
          parsed = await response.json();
        }
      } catch (err) {
        throw new KovanicaTransportError("Malformed JSON response from RPC server", {
          cause: err,
        });
      }

      if (!Array.isArray(parsed)) {
        throw new KovanicaTransportError(
          "Invalid JSON-RPC 2.0 batch response: payload must be a JSON array",
        );
      }

      const results = new Array<JsonRpcBatchItemResult<TResult> | undefined>(requests.length);
      const seenIds = new Set<string | number>();

      for (let i = 0; i < parsed.length; i++) {
        const entry = parsed[i];
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new KovanicaTransportError(
            `Invalid JSON-RPC 2.0 batch response item at index ${i}: entry must be a JSON object`,
          );
        }

        const rpcRes = entry as Partial<JsonRpcResponse<TResult>>;

        if (rpcRes.jsonrpc !== "2.0") {
          throw new KovanicaTransportError(
            `Invalid JSON-RPC 2.0 batch response item at index ${i}: missing or invalid "jsonrpc" version (expected "2.0", got "${rpcRes.jsonrpc}")`,
          );
        }

        if (rpcRes.result === undefined && rpcRes.error === undefined) {
          throw new KovanicaTransportError(
            `Invalid JSON-RPC 2.0 batch response item at index ${i}: neither result nor error member present`,
          );
        }

        if (rpcRes.result !== undefined && rpcRes.error !== undefined) {
          throw new KovanicaTransportError(
            `Invalid JSON-RPC 2.0 batch response item at index ${i}: both result and error members present`,
          );
        }

        if (typeof rpcRes.id !== "string" && typeof rpcRes.id !== "number") {
          throw new KovanicaTransportError(
            `Invalid JSON-RPC 2.0 batch response item at index ${i}: missing or invalid response id`,
          );
        }

        const targetIndex = idToIndex.get(rpcRes.id);
        if (targetIndex === undefined) {
          throw new KovanicaTransportError(
            `Invalid JSON-RPC 2.0 batch response: unexpected response id ${String(rpcRes.id)}`,
          );
        }

        if (seenIds.has(rpcRes.id)) {
          throw new KovanicaTransportError(
            `Invalid JSON-RPC 2.0 batch response: duplicate response id ${String(rpcRes.id)}`,
          );
        }
        seenIds.add(rpcRes.id);

        if (rpcRes.error !== undefined) {
          if (
            typeof rpcRes.error !== "object" ||
            rpcRes.error === null ||
            typeof rpcRes.error.code !== "number" ||
            typeof rpcRes.error.message !== "string"
          ) {
            throw new KovanicaTransportError(
              `Invalid JSON-RPC 2.0 batch response item at index ${i}: malformed error object`,
            );
          }
          results[targetIndex] = {
            ok: false,
            error: new KovanicaRpcError(
              rpcRes.error.code,
              rpcRes.error.message,
              rpcRes.error.data,
            ),
          };
        } else {
          results[targetIndex] = {
            ok: true,
            result: rpcRes.result as TResult,
          };
        }
      }

      for (let i = 0; i < payload.length; i++) {
        if (results[i] === undefined) {
          throw new KovanicaTransportError(
            `Invalid JSON-RPC 2.0 batch response: missing response for request id ${String(payload[i]!.id)}`,
          );
        }
      }

      return results as Array<JsonRpcBatchItemResult<TResult>>;
    } catch (err: unknown) {
      if (isTimedOut) {
        throw new KovanicaTimeoutError(timeoutMs);
      }
      if (options?.signal?.aborted) {
        throw new KovanicaAbortError("Request was cancelled by user");
      }
      if (
        err instanceof KovanicaRpcError ||
        err instanceof KovanicaTransportError
      ) {
        throw err;
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new KovanicaAbortError("Request was aborted");
      }
      throw new KovanicaTransportError(
        sanitizeDiagnostics(err instanceof Error ? err.message : String(err)),
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
      if (removeUserSignalListener) {
        removeUserSignalListener();
      }
    }
  }
}

const DEFAULT_FAILOVER_MAX_RETRIES_PER_ENDPOINT = 1;
const DEFAULT_FAILOVER_BASE_BACKOFF_MS = 150;
const DEFAULT_FAILOVER_MAX_BACKOFF_MS = 5_000;
const DEFAULT_FAILOVER_COOLDOWN_MS = 15_000;
const DEFAULT_FAILOVER_JITTER_RATIO = 0.2;

const SENSITIVE_QUERY_KEY_PATTERN =
  /^(?:api[-_]?key|key|token|access[-_]?token|auth[-_]?token|auth|secret|password|passwd|pass|bearer|jwt|credential|credentials|session|sig|signature)$/i;

/**
 * Strips embedded credentials (`user:pass@`), URL fragments, and sensitive query parameters
 * (such as `token`, `api_key`, `key`, `secret`, `password`, `auth`) from an RPC URL so
 * credentials never leak into error messages, health snapshots, or failover events.
 */
export function sanitizeRpcUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    parsed.username = "";
    parsed.password = "";
    const keysToDelete: string[] = [];
    parsed.searchParams.forEach((_value, key) => {
      if (SENSITIVE_QUERY_KEY_PATTERN.test(key)) {
        keysToDelete.push(key);
      }
    });
    for (const key of keysToDelete) {
      parsed.searchParams.delete(key);
    }
    if (parsed.hash) {
      parsed.hash = "";
    }
    return parsed.toString();
  } catch {
    return sanitizeDiagnostics(
      trimmed
        .replace(/:\/\/[^/@\s]+@/g, "://")
        .replace(
          /([?&])(api[-_]?key|key|token|access[-_]?token|auth[-_]?token|auth|secret|password|passwd|pass|bearer|jwt|credential|credentials|session|sig|signature)=[^&#\s]*/gi,
          "$1",
        )
        .replace(/[?&]+$/g, ""),
    );
  }
}

export interface FailoverEndpointHealth {
  /** Sanitized endpoint URL (credentials and sensitive query tokens stripped). */
  readonly url: string;
  /** True when the endpoint is not currently in circuit-breaker cooldown. */
  readonly healthy: boolean;
  /** Circuit-breaker state: `"closed"` (healthy), `"open"` (cooling down), or `"half-open"` (cooldown elapsed). */
  readonly state: "closed" | "open" | "half-open";
  /** Consecutive transient failures recorded against this endpoint. */
  readonly consecutiveFailures: number;
  /** Total transient failures recorded over the lifetime of this transport. */
  readonly totalFailures: number;
  /** Total successful responses recorded over the lifetime of this transport. */
  readonly totalSuccesses: number;
  /** Timestamp (ms) of the most recent failure, if any. */
  readonly lastFailureAt?: number;
  /** Timestamp (ms) of the most recent success, if any. */
  readonly lastSuccessAt?: number;
  /** Timestamp (ms) until which the circuit remains open, if currently open. */
  readonly cooldownUntil?: number;
  /** Sanitized message from the most recent failure, if any. */
  readonly lastError?: string;
}

export interface FailoverEvent {
  /** Sanitized URL of the endpoint that failed. */
  readonly fromUrl: string;
  /** Sanitized URL of the next endpoint being tried, if any. */
  readonly toUrl?: string;
  /** JSON-RPC method name (or `"batch"` for `sendBatch`). */
  readonly method: string;
  /** Total attempts executed on `fromUrl` before failing over. */
  readonly attempts: number;
  /** Sanitized error message that triggered the failover. */
  readonly reason: string;
  /** HTTP status code if the failure was an HTTP error. */
  readonly status?: number;
  /** Timestamp (ms) when the failover occurred. */
  readonly timestamp: number;
  /** Timestamp (ms) until which `fromUrl` is placed in circuit-breaker cooldown. */
  readonly cooldownUntil?: number;
}

export interface FailoverHttpTransportOptions {
  /** Ordered list of HTTP(S) JSON-RPC endpoint URLs (primary first). */
  urls: readonly string[];
  /** Default timeout in milliseconds per attempt. Default: 10_000ms. */
  timeoutMs?: number;
  /** Maximum retries per endpoint after the initial attempt fails. Default: 1. */
  maxRetriesPerEndpoint?: number;
  /** Base backoff delay in milliseconds for per-endpoint retries. Default: 150ms. */
  baseBackoffMs?: number;
  /** Upper bound in milliseconds for capped exponential backoff. Default: 5_000ms. */
  maxBackoffMs?: number;
  /** Circuit-breaker cooldown in milliseconds after an endpoint fails. Default: 15_000ms. */
  cooldownMs?: number;
  /** Custom HTTP headers sent with every request. */
  headers?: Record<string, string>;
  /** Custom fetch implementation (useful for tests or custom proxies). */
  fetch?: typeof fetch;
  /** Custom ID generator forwarded to underlying transports. */
  requestIdGenerator?: () => number | string;
  /** Injectable clock (ms since epoch) for deterministic tests. Default: `Date.now`. */
  now?: () => number;
  /** Injectable sleep function for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable PRNG in `[0, 1)` for deterministic backoff jitter in tests. Default: `Math.random`. */
  randomFn?: () => number;
  /** Optional hook notified whenever a request fails over from one endpoint to another. */
  onFailover?: (event: FailoverEvent) => void;
}

interface EndpointSlot {
  readonly rawUrl: string;
  readonly sanitizedUrl: string;
  readonly transport: HttpTransport;
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  cooldownUntil?: number;
  lastError?: string;
}

function isRetryableFailoverError(err: unknown): boolean {
  if (err instanceof KovanicaAbortError) {
    return false;
  }
  if (err instanceof KovanicaRpcError) {
    return false;
  }
  if (err instanceof KovanicaTimeoutError) {
    return true;
  }
  if (err instanceof KovanicaTransportError) {
    if (err.status === undefined) {
      return true;
    }
    return err.status === 429 || (err.status >= 500 && err.status < 600);
  }
  return true;
}

function sanitizeErrorMessageForEndpoints(
  err: unknown,
  endpoints: ReadonlyArray<EndpointSlot>,
): string {
  let msg = err instanceof Error ? err.message : String(err);
  for (const ep of endpoints) {
    if (ep.rawUrl !== ep.sanitizedUrl && msg.includes(ep.rawUrl)) {
      msg = msg.split(ep.rawUrl).join(ep.sanitizedUrl);
    }
  }
  msg = msg.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => sanitizeRpcUrl(match));
  return sanitizeDiagnostics(msg);
}

function defaultAbortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  if (signal?.aborted) {
    return Promise.reject(new KovanicaAbortError("Request was cancelled by user"));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new KovanicaAbortError("Request was cancelled by user"));
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Browser-safe multi-endpoint JSON-RPC HTTP transport with per-endpoint bounded
 * exponential-backoff retries, automatic failover across endpoints, and a
 * per-endpoint circuit breaker with cooldown.
 */
export class FailoverHttpTransport implements Transport {
  /** Sanitized endpoint URLs in priority order. */
  readonly urls: ReadonlyArray<string>;
  private readonly endpoints: EndpointSlot[];
  private readonly maxRetriesPerEndpoint: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly cooldownMs: number;
  private readonly nowFn: () => number;
  private readonly customSleep?: (ms: number) => Promise<void>;
  private readonly randomFn: () => number;
  private readonly onFailover?: (event: FailoverEvent) => void;

  constructor(options: FailoverHttpTransportOptions) {
    if (!options || !Array.isArray(options.urls) || options.urls.length === 0) {
      throw new Error("FailoverHttpTransport requires a non-empty list of RPC URLs");
    }

    const slots: EndpointSlot[] = [];
    for (let i = 0; i < options.urls.length; i++) {
      const raw = options.urls[i];
      if (typeof raw !== "string" || raw.trim().length === 0) {
        throw new Error(`FailoverHttpTransport URL at index ${i} must be a non-empty string`);
      }
      const trimmed = raw.trim();
      let parsed: URL;
      try {
        parsed = new URL(trimmed);
      } catch {
        throw new Error(
          `Invalid RPC URL at index ${i}: "${sanitizeRpcUrl(trimmed)}"`,
        );
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(
          `Invalid RPC URL scheme "${parsed.protocol}" at index ${i} ("${sanitizeRpcUrl(trimmed)}"): only http: and https: are supported`,
        );
      }

      const sanitizedUrl = sanitizeRpcUrl(trimmed);
      const transport = new HttpTransport({
        url: trimmed,
        headers: options.headers,
        timeoutMs: options.timeoutMs,
        fetch: options.fetch,
        requestIdGenerator: options.requestIdGenerator,
      });

      slots.push({
        rawUrl: trimmed,
        sanitizedUrl,
        transport,
        consecutiveFailures: 0,
        totalFailures: 0,
        totalSuccesses: 0,
      });
    }

    this.endpoints = slots;
    this.urls = Object.freeze(slots.map((slot) => slot.sanitizedUrl));

    const rawRetries = options.maxRetriesPerEndpoint;
    this.maxRetriesPerEndpoint =
      rawRetries !== undefined && Number.isFinite(rawRetries)
        ? Math.max(0, Math.floor(rawRetries))
        : DEFAULT_FAILOVER_MAX_RETRIES_PER_ENDPOINT;

    const rawBackoff = options.baseBackoffMs;
    this.baseBackoffMs =
      rawBackoff !== undefined && Number.isFinite(rawBackoff)
        ? Math.max(0, rawBackoff)
        : DEFAULT_FAILOVER_BASE_BACKOFF_MS;

    const rawMaxBackoff = options.maxBackoffMs;
    this.maxBackoffMs =
      rawMaxBackoff !== undefined && Number.isFinite(rawMaxBackoff)
        ? Math.max(this.baseBackoffMs, rawMaxBackoff)
        : Math.max(this.baseBackoffMs, DEFAULT_FAILOVER_MAX_BACKOFF_MS);

    const rawCooldown = options.cooldownMs;
    this.cooldownMs =
      rawCooldown !== undefined && Number.isFinite(rawCooldown)
        ? Math.max(0, rawCooldown)
        : DEFAULT_FAILOVER_COOLDOWN_MS;

    this.nowFn = options.now ?? (() => Date.now());
    this.customSleep = options.sleep;
    this.randomFn = options.randomFn ?? Math.random;
    this.onFailover = options.onFailover;
  }

  /**
   * Returns a point-in-time health snapshot for every configured endpoint.
   */
  getEndpointHealth(): FailoverEndpointHealth[] {
    const now = this.nowFn();
    return this.endpoints.map((slot) => {
      let state: "closed" | "open" | "half-open";
      let healthy: boolean;
      if (slot.cooldownUntil !== undefined && now < slot.cooldownUntil) {
        state = "open";
        healthy = false;
      } else if (slot.cooldownUntil !== undefined) {
        state = "half-open";
        healthy = true;
      } else {
        state = "closed";
        healthy = true;
      }

      return {
        url: slot.sanitizedUrl,
        healthy,
        state,
        consecutiveFailures: slot.consecutiveFailures,
        totalFailures: slot.totalFailures,
        totalSuccesses: slot.totalSuccesses,
        lastFailureAt: slot.lastFailureAt,
        lastSuccessAt: slot.lastSuccessAt,
        cooldownUntil: state === "open" ? slot.cooldownUntil : undefined,
        lastError: slot.lastError,
      };
    });
  }

  private selectCandidates(now: number): EndpointSlot[] {
    const available = this.endpoints.filter(
      (slot) => slot.cooldownUntil === undefined || now >= slot.cooldownUntil,
    );
    if (available.length > 0) {
      return available;
    }
    // All endpoints are currently in cooldown: probe in order of earliest cooldown expiry.
    return [...this.endpoints].sort(
      (a, b) => (a.cooldownUntil ?? 0) - (b.cooldownUntil ?? 0),
    );
  }

  private computeBackoffMs(retryIndex: number): number {
    if (this.baseBackoffMs <= 0) {
      return 0;
    }
    const exp = Math.min(this.maxBackoffMs, this.baseBackoffMs * Math.pow(2, retryIndex));
    const rand = this.randomFn();
    const clampedRand = Number.isFinite(rand) ? Math.min(1, Math.max(0, rand)) : 0.5;
    const jitterFactor =
      1 - DEFAULT_FAILOVER_JITTER_RATIO + clampedRand * (2 * DEFAULT_FAILOVER_JITTER_RATIO);
    return Math.min(this.maxBackoffMs, Math.max(0, Math.round(exp * jitterFactor)));
  }

  private async sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new KovanicaAbortError("Request was cancelled by user");
    }
    if (this.customSleep) {
      await this.customSleep(ms);
      if (signal?.aborted) {
        throw new KovanicaAbortError("Request was cancelled by user");
      }
      return;
    }
    await defaultAbortableSleep(ms, signal);
  }

  private recordSuccess(slot: EndpointSlot): void {
    slot.consecutiveFailures = 0;
    slot.cooldownUntil = undefined;
    slot.lastError = undefined;
    slot.lastSuccessAt = this.nowFn();
    slot.totalSuccesses += 1;
  }

  private recordFailure(slot: EndpointSlot, sanitizedReason: string): number | undefined {
    const now = this.nowFn();
    slot.consecutiveFailures += 1;
    slot.totalFailures += 1;
    slot.lastFailureAt = now;
    slot.lastError = sanitizedReason;
    slot.cooldownUntil = this.cooldownMs > 0 ? now + this.cooldownMs : undefined;
    return slot.cooldownUntil;
  }

  private emitFailover(event: FailoverEvent): void {
    if (!this.onFailover) {
      return;
    }
    try {
      this.onFailover(event);
    } catch {
      // Never allow observer errors to disrupt transport failover.
    }
  }

  private async executeWithFailover<T>(
    methodLabel: string,
    options: RequestOptions | undefined,
    invoke: (transport: HttpTransport) => Promise<T>,
  ): Promise<T> {
    if (options?.signal?.aborted) {
      throw new KovanicaAbortError("Request was already aborted");
    }

    const candidates = this.selectCandidates(this.nowFn());
    let lastError: unknown;
    let lastStatus: number | undefined;
    let lastStatusText: string | undefined;
    let lastSanitizedReason = "Unknown transport error";
    const triedUrls: string[] = [];

    for (let epIndex = 0; epIndex < candidates.length; epIndex++) {
      const slot = candidates[epIndex]!;
      triedUrls.push(slot.sanitizedUrl);

      const maxAttempts = 1 + this.maxRetriesPerEndpoint;
      let attempts = 0;
      let endpointError: unknown;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (options?.signal?.aborted) {
          throw new KovanicaAbortError("Request was cancelled by user");
        }
        attempts += 1;

        try {
          const result = await invoke(slot.transport);
          this.recordSuccess(slot);
          return result;
        } catch (err: unknown) {
          if (err instanceof KovanicaAbortError || options?.signal?.aborted) {
            throw err instanceof KovanicaAbortError
              ? err
              : new KovanicaAbortError("Request was cancelled by user");
          }

          if (err instanceof KovanicaRpcError) {
            // Deterministic JSON-RPC error (HTTP 200) proves endpoint liveness; never retry.
            this.recordSuccess(slot);
            throw err;
          }

          if (!isRetryableFailoverError(err)) {
            throw err;
          }

          endpointError = err;
          if (attempt < maxAttempts - 1) {
            const delayMs = this.computeBackoffMs(attempt);
            if (delayMs > 0) {
              await this.sleepWithSignal(delayMs, options?.signal);
            }
          }
        }
      }

      const sanitizedReason = sanitizeErrorMessageForEndpoints(
        endpointError,
        this.endpoints,
      );
      const cooldownUntil = this.recordFailure(slot, sanitizedReason);
      lastError = endpointError;
      lastSanitizedReason = sanitizedReason;
      if (endpointError instanceof KovanicaTransportError) {
        lastStatus = endpointError.status;
        lastStatusText = endpointError.statusText;
      } else {
        lastStatus = undefined;
        lastStatusText = undefined;
      }

      const nextSlot = candidates[epIndex + 1];
      this.emitFailover({
        fromUrl: slot.sanitizedUrl,
        toUrl: nextSlot?.sanitizedUrl,
        method: methodLabel,
        attempts,
        reason: sanitizedReason,
        status: lastStatus,
        timestamp: this.nowFn(),
        cooldownUntil,
      });
    }

    throw new KovanicaTransportError(
      `All ${triedUrls.length} RPC endpoint(s) failed for ${methodLabel} [${triedUrls.join(", ")}]: ${lastSanitizedReason}`,
      {
        status: lastStatus,
        statusText: lastStatusText,
        cause: lastError,
      },
    );
  }

  async send<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<TResult> {
    return this.executeWithFailover(method, options, (transport) =>
      transport.send<TResult>(method, params, options),
    );
  }

  async sendBatch<TResult = unknown>(
    requests: ReadonlyArray<JsonRpcBatchRequestItem>,
    options?: RequestOptions,
  ): Promise<Array<JsonRpcBatchItemResult<TResult>>> {
    // Validate fail-closed before any endpoint selection or network I/O.
    validateJsonRpcBatchRequests(requests);
    return this.executeWithFailover("batch", options, (transport) =>
      transport.sendBatch<TResult>(requests, options),
    );
  }
}

/**
 * Convenience factory for creating a {@link FailoverHttpTransport}.
 */
export function createFailoverHttpTransport(
  options: FailoverHttpTransportOptions,
): FailoverHttpTransport {
  return new FailoverHttpTransport(options);
}
