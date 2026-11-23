/**
 * Browser-safe RPC node capability and network-tag header probe for Kovanica.
 *
 * Executes a single-POST JSON-RPC 2.0 batch (`kovanica_chainId`, `kovanica_blockNumber`,
 * `kovanica_estimateFee`), correlates responses by `id`, inspects `X-Kovanica-*`
 * response headers, and verifies canonical network tags for Mainnet (Chain 1) and
 * Testnet (Chain 2).
 */

import { CHAIN_IDS, NETWORK_TAGS } from "./chains";
import { parseLosslessJson, sanitizeDiagnostics, sanitizeRpcUrl } from "./transport";
import { parseQuantity } from "./units";

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

const BATCH_ID_CHAIN_ID = 1;
const BATCH_ID_BLOCK_NUMBER = 2;
const BATCH_ID_ESTIMATE_FEE = 3;

const HEADER_NETWORK_TAG = "X-Kovanica-Network-Tag";
const HEADER_RPC_VERSION = "X-Kovanica-Rpc-Version";
const HEADER_CHAIN_ID = "X-Kovanica-Chain-Id";

export interface RpcNodeProbeOptions {
  /** Request timeout in milliseconds. Default: 10_000ms. */
  timeoutMs?: number;
  /** Custom fetch implementation (useful for tests or custom proxies). */
  fetch?: typeof fetch;
  /** Additional HTTP headers sent with the probe request. */
  headers?: Record<string, string>;
  /** Optional expected chain ID; probe fails (`ok: false`) if the node reports a different chain ID. */
  expectedChainId?: number | bigint;
  /** Optional AbortSignal to cancel the probe. */
  signal?: AbortSignal;
  /** Injectable clock (ms since epoch) for deterministic latency measurement in tests. Default: `Date.now`. */
  now?: () => number;
}

export interface RpcNodeProbeResult {
  /** True when the node responded cleanly with valid batch results, matching chainId (if expected), and non-mismatched canonical tag. */
  ok: boolean;
  /** Sanitized RPC endpoint URL (credentials and sensitive query params stripped). */
  url: string;
  /** Chain ID reported by `kovanica_chainId`. */
  chainId?: bigint;
  /** Latest block height reported by `kovanica_blockNumber`. */
  blockHeight?: bigint;
  /** Suggested fee rate reported by `kovanica_estimateFee`. */
  feeRate?: bigint;
  /** True when the endpoint returned a JSON-RPC 2.0 batch array response; false on legacy non-array responses or transport failures. */
  batchSupported: boolean;
  /** Value of the `X-Kovanica-Network-Tag` HTTP response header, if present. */
  networkTag?: string;
  /** Value of the `X-Kovanica-Rpc-Version` HTTP response header, if present. */
  rpcVersion?: string;
  /** Parsed value of the `X-Kovanica-Chain-Id` HTTP response header, if present. */
  headerChainId?: bigint;
  /**
   * Canonical network-tag verification for Chains 1 & 2:
   * - `true`: header matches the canonical tag (`1-f35df34c92001436` or `2-24cdb5fadd98b207`)
   * - `false`: header is present for Chain 1 or 2 and does NOT match the canonical tag
   * - `null`: header is absent, chain ID is unavailable, or chain ID is not Chain 1 / Chain 2
   */
  canonicalTagMatch: boolean | null;
  /** Elapsed probe latency in milliseconds. */
  latencyMs: number;
  /** Sanitized error description when `ok` is `false`. */
  error?: string;
}

interface RawJsonRpcItem {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

function canonicalNetworkTagForChain(chainId: bigint): string | undefined {
  if (chainId === BigInt(CHAIN_IDS.MAINNET)) {
    return NETWORK_TAGS.MAINNET;
  }
  if (chainId === BigInt(CHAIN_IDS.TESTNET)) {
    return NETWORK_TAGS.TESTNET;
  }
  return undefined;
}

function evaluateCanonicalTagMatch(
  chainId: bigint | undefined,
  networkTag: string | undefined,
): boolean | null {
  if (chainId === undefined || networkTag === undefined) {
    return null;
  }
  const canonical = canonicalNetworkTagForChain(chainId);
  if (canonical === undefined) {
    return null;
  }
  return networkTag === canonical;
}

function readHeader(headers: Headers | undefined | null, name: string): string | undefined {
  if (!headers || typeof headers.get !== "function") {
    return undefined;
  }
  const value = headers.get(name);
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeProbeError(message: string, rawUrl: string, sanitizedUrl: string): string {
  let out = message;
  if (rawUrl && rawUrl !== sanitizedUrl && out.includes(rawUrl)) {
    out = out.split(rawUrl).join(sanitizedUrl);
  }
  out = out.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (match) => sanitizeRpcUrl(match));
  return sanitizeDiagnostics(out);
}

function formatRpcErrorObject(errObj: unknown): string {
  if (errObj && typeof errObj === "object") {
    const code = (errObj as { code?: unknown }).code;
    const message = (errObj as { message?: unknown }).message;
    if (typeof code === "number" && typeof message === "string") {
      return `RPC error ${code}: ${message}`;
    }
    if (typeof message === "string") {
      return message;
    }
  }
  return "Unknown JSON-RPC error";
}

/**
 * Probes a Kovanica JSON-RPC endpoint for liveness, batch support, chain metadata,
 * and `X-Kovanica-*` network-tag / version headers in a single HTTP POST.
 */
export async function probeRpcNode(
  url: string,
  options?: RpcNodeProbeOptions,
): Promise<RpcNodeProbeResult> {
  const nowFn = options?.now ?? (() => Date.now());
  const startedAt = nowFn();
  const elapsedMs = (): number => Math.max(0, nowFn() - startedAt);

  const rawTrimmed = typeof url === "string" ? url.trim() : "";
  const sanitizedUrl = sanitizeRpcUrl(rawTrimmed);

  if (!rawTrimmed) {
    return {
      ok: false,
      url: sanitizedUrl,
      batchSupported: false,
      canonicalTagMatch: null,
      latencyMs: elapsedMs(),
      error: "RPC URL must be a non-empty string",
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawTrimmed);
  } catch {
    return {
      ok: false,
      url: sanitizedUrl,
      batchSupported: false,
      canonicalTagMatch: null,
      latencyMs: elapsedMs(),
      error: `Invalid RPC URL: "${sanitizedUrl}"`,
    };
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return {
      ok: false,
      url: sanitizedUrl,
      batchSupported: false,
      canonicalTagMatch: null,
      latencyMs: elapsedMs(),
      error: `Invalid RPC URL scheme "${parsedUrl.protocol}" ("${sanitizedUrl}"): only http: and https: are supported`,
    };
  }

  let expectedChainIdBigInt: bigint | undefined;
  if (options?.expectedChainId !== undefined) {
    try {
      expectedChainIdBigInt = parseQuantity(options.expectedChainId);
    } catch (err: unknown) {
      return {
        ok: false,
        url: sanitizedUrl,
        batchSupported: false,
        canonicalTagMatch: null,
        latencyMs: elapsedMs(),
        error: sanitizeProbeError(
          `Invalid expectedChainId: ${err instanceof Error ? err.message : String(err)}`,
          rawTrimmed,
          sanitizedUrl,
        ),
      };
    }
  }

  const fetchFn = options?.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    return {
      ok: false,
      url: sanitizedUrl,
      batchSupported: false,
      canonicalTagMatch: null,
      latencyMs: elapsedMs(),
      error: "Fetch API is not available in this runtime",
    };
  }

  const rawTimeout = options?.timeoutMs;
  const timeoutMs =
    rawTimeout !== undefined && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout
      : DEFAULT_PROBE_TIMEOUT_MS;

  if (options?.signal?.aborted) {
    return {
      ok: false,
      url: sanitizedUrl,
      batchSupported: false,
      canonicalTagMatch: null,
      latencyMs: elapsedMs(),
      error: "Probe request was already aborted",
    };
  }

  const controller = new AbortController();
  let isTimedOut = false;
  const timer = setTimeout(() => {
    isTimedOut = true;
    controller.abort();
  }, timeoutMs);

  let removeUserSignalListener: (() => void) | undefined;
  if (options?.signal) {
    const onUserAbort = () => {
      controller.abort();
    };
    options.signal.addEventListener("abort", onUserAbort, { once: true });
    removeUserSignalListener = () => {
      options.signal?.removeEventListener("abort", onUserAbort);
    };
  }

  const batchPayload = [
    { jsonrpc: "2.0", id: BATCH_ID_CHAIN_ID, method: "kovanica_chainId", params: [] },
    { jsonrpc: "2.0", id: BATCH_ID_BLOCK_NUMBER, method: "kovanica_blockNumber", params: [] },
    { jsonrpc: "2.0", id: BATCH_ID_ESTIMATE_FEE, method: "kovanica_estimateFee", params: [] },
  ];

  try {
    const response = await fetchFn(rawTrimmed, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
      body: JSON.stringify(batchPayload),
      signal: controller.signal,
    });

    const networkTag = readHeader(response.headers, HEADER_NETWORK_TAG);
    const rpcVersion = readHeader(response.headers, HEADER_RPC_VERSION);
    const rawHeaderChainId = readHeader(response.headers, HEADER_CHAIN_ID);
    let headerChainId: bigint | undefined;
    if (rawHeaderChainId !== undefined) {
      try {
        headerChainId = parseQuantity(rawHeaderChainId);
      } catch {
        // Ignore unparseable header chain ID; rely on JSON-RPC kovanica_chainId
      }
    }

    const headerFields = {
      ...(networkTag !== undefined ? { networkTag } : {}),
      ...(rpcVersion !== undefined ? { rpcVersion } : {}),
      ...(headerChainId !== undefined ? { headerChainId } : {}),
    };

    if (!response.ok) {
      const bodyText =
        typeof response.text === "function" ? await response.text().catch(() => "") : "";
      const sanitizedBody = sanitizeProbeError(bodyText, rawTrimmed, sanitizedUrl);
      const statusPart = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
      return {
        ok: false,
        url: sanitizedUrl,
        batchSupported: false,
        ...headerFields,
        canonicalTagMatch: evaluateCanonicalTagMatch(headerChainId, networkTag),
        latencyMs: elapsedMs(),
        error: sanitizedBody ? `${statusPart}: ${sanitizedBody}` : statusPart,
      };
    }

    let parsed: unknown;
    try {
      if (typeof response.text === "function") {
        const text = await response.text();
        parsed = parseLosslessJson(text);
      } else {
        parsed = await response.json();
      }
    } catch (err: unknown) {
      return {
        ok: false,
        url: sanitizedUrl,
        batchSupported: false,
        ...headerFields,
        canonicalTagMatch: evaluateCanonicalTagMatch(headerChainId, networkTag),
        latencyMs: elapsedMs(),
        error: sanitizeProbeError(
          `Malformed JSON response from RPC server: ${err instanceof Error ? err.message : String(err)}`,
          rawTrimmed,
          sanitizedUrl,
        ),
      };
    }

    if (!Array.isArray(parsed)) {
      const legacyErr =
        parsed && typeof parsed === "object" && (parsed as RawJsonRpcItem).error !== undefined
          ? ` (${formatRpcErrorObject((parsed as RawJsonRpcItem).error)})`
          : "";
      return {
        ok: false,
        url: sanitizedUrl,
        batchSupported: false,
        ...headerFields,
        canonicalTagMatch: evaluateCanonicalTagMatch(headerChainId, networkTag),
        latencyMs: elapsedMs(),
        error: sanitizeProbeError(
          `RPC node does not support JSON-RPC 2.0 batch requests: expected JSON array response${legacyErr}`,
          rawTrimmed,
          sanitizedUrl,
        ),
      };
    }

    const byId = new Map<number, RawJsonRpcItem>();
    for (let i = 0; i < parsed.length; i++) {
      const entry = parsed[i];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return {
          ok: false,
          url: sanitizedUrl,
          batchSupported: true,
          ...headerFields,
          canonicalTagMatch: evaluateCanonicalTagMatch(headerChainId, networkTag),
          latencyMs: elapsedMs(),
          error: `Invalid JSON-RPC 2.0 batch response item at index ${i}: expected object`,
        };
      }
      const item = entry as RawJsonRpcItem;
      if (item.jsonrpc !== "2.0") {
        return {
          ok: false,
          url: sanitizedUrl,
          batchSupported: true,
          ...headerFields,
          canonicalTagMatch: evaluateCanonicalTagMatch(headerChainId, networkTag),
          latencyMs: elapsedMs(),
          error: `Invalid JSON-RPC 2.0 batch response item at index ${i}: invalid jsonrpc version`,
        };
      }
      if (typeof item.id !== "number") {
        return {
          ok: false,
          url: sanitizedUrl,
          batchSupported: true,
          ...headerFields,
          canonicalTagMatch: evaluateCanonicalTagMatch(headerChainId, networkTag),
          latencyMs: elapsedMs(),
          error: `Invalid JSON-RPC 2.0 batch response item at index ${i}: invalid response id`,
        };
      }
      if (byId.has(item.id)) {
        return {
          ok: false,
          url: sanitizedUrl,
          batchSupported: true,
          ...headerFields,
          canonicalTagMatch: evaluateCanonicalTagMatch(headerChainId, networkTag),
          latencyMs: elapsedMs(),
          error: `Duplicate JSON-RPC batch response id ${item.id}`,
        };
      }
      byId.set(item.id, item);
    }

    const errors: string[] = [];
    let chainId: bigint | undefined;
    let blockHeight: bigint | undefined;
    let feeRate: bigint | undefined;

    const extractQuantity = (id: number, methodName: string): bigint | undefined => {
      const item = byId.get(id);
      if (!item) {
        errors.push(`Missing batch response for ${methodName} (id=${id})`);
        return undefined;
      }
      if (item.error !== undefined) {
        errors.push(`${methodName} failed: ${formatRpcErrorObject(item.error)}`);
        return undefined;
      }
      if (item.result === undefined) {
        errors.push(`${methodName} returned neither result nor error`);
        return undefined;
      }
      try {
        return parseQuantity(item.result);
      } catch (err: unknown) {
        errors.push(
          `${methodName} returned invalid quantity: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
    };

    chainId = extractQuantity(BATCH_ID_CHAIN_ID, "kovanica_chainId");
    blockHeight = extractQuantity(BATCH_ID_BLOCK_NUMBER, "kovanica_blockNumber");
    feeRate = extractQuantity(BATCH_ID_ESTIMATE_FEE, "kovanica_estimateFee");

    const effectiveChainId = chainId ?? headerChainId;
    const canonicalTagMatch = evaluateCanonicalTagMatch(effectiveChainId, networkTag);

    if (
      expectedChainIdBigInt !== undefined &&
      chainId !== undefined &&
      chainId !== expectedChainIdBigInt
    ) {
      errors.push(`Expected chainId ${expectedChainIdBigInt}, got ${chainId}`);
    }

    if (canonicalTagMatch === false && effectiveChainId !== undefined) {
      const expectedTag = canonicalNetworkTagForChain(effectiveChainId);
      errors.push(
        `Canonical network tag mismatch for chain ${effectiveChainId}: expected "${expectedTag}", got "${networkTag}"`,
      );
    }

    const resultBase: RpcNodeProbeResult = {
      ok: errors.length === 0,
      url: sanitizedUrl,
      ...(chainId !== undefined ? { chainId } : {}),
      ...(blockHeight !== undefined ? { blockHeight } : {}),
      ...(feeRate !== undefined ? { feeRate } : {}),
      batchSupported: true,
      ...headerFields,
      canonicalTagMatch,
      latencyMs: elapsedMs(),
      ...(errors.length > 0
        ? { error: sanitizeProbeError(errors.join("; "), rawTrimmed, sanitizedUrl) }
        : {}),
    };

    return resultBase;
  } catch (err: unknown) {
    let errorMessage: string;
    if (isTimedOut) {
      errorMessage = `RPC probe timed out after ${timeoutMs}ms`;
    } else if (options?.signal?.aborted) {
      errorMessage = "Probe request was cancelled by user";
    } else if (err instanceof Error && err.name === "AbortError") {
      errorMessage = "Probe request was aborted";
    } else {
      errorMessage = sanitizeProbeError(
        err instanceof Error ? err.message : String(err),
        rawTrimmed,
        sanitizedUrl,
      );
    }

    return {
      ok: false,
      url: sanitizedUrl,
      batchSupported: false,
      canonicalTagMatch: null,
      latencyMs: elapsedMs(),
      error: errorMessage,
    };
  } finally {
    clearTimeout(timer);
    if (removeUserSignalListener) {
      removeUserSignalListener();
    }
  }
}
