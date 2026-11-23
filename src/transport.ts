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
