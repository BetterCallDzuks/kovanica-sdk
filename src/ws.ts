/**
 * Typed WebSocket subscription client for Kovanica JSON-RPC (`GET /ws`).
 *
 * Supports JSON-RPC 2.0 `kovanica_subscribe` / `kovanica_unsubscribe` and
 * `kovanica_subscription` push notifications matching `kovanica-rpc/src/subscriptions.rs`.
 */

import {
  KovanicaAbortError,
  KovanicaRpcError,
  KovanicaTimeoutError,
  KovanicaTransportError,
} from "./errors";
import { parseLosslessJson, sanitizeDiagnostics } from "./transport";
import type {
  BlockResponse,
  JsonRpcRequest,
  JsonRpcResponse,
  RequestOptions,
  TransactionReceipt,
} from "./types";

const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_METHOD = "kovanica_chainId";

/** Default maximum number of buffered notifications per subscription before backpressure drops occur. */
export const DEFAULT_WS_MAX_QUEUE_SIZE = 256;

/** Default maximum number of concurrent `getTransactionReceipt` calls per block in {@link subscribeNewBlocksWithReceipts}. */
export const DEFAULT_BLOCK_RECEIPT_CONCURRENCY = 8;

/** Backpressure policy applied when a subscription's pending queue reaches `maxQueueSize`. */
export type WsBackpressureOverflowPolicy = "drop-oldest" | "drop-newest" | "error";

const VALID_OVERFLOW_POLICIES: ReadonlySet<WsBackpressureOverflowPolicy> = new Set([
  "drop-oldest",
  "drop-newest",
  "error",
]);

/** Telemetry payload emitted when an incoming event is dropped due to backpressure. */
export interface WsBackpressureDropEvent<T = unknown> {
  /** Overflow policy that caused the drop. */
  policy: WsBackpressureOverflowPolicy;
  /** Subscription ID associated with the drop, when applicable. */
  subscriptionId?: string;
  /** The dropped event payload. */
  droppedItem: T;
  /** Queue occupancy after applying the overflow policy. */
  queueSize: number;
  /** Configured maximum queue capacity. */
  maxQueueSize: number;
  /** Cumulative number of dropped events. */
  droppedCount: number;
}

function resolvePositiveSafeIntegerOption(
  value: number | undefined,
  fallback: number,
  fieldName: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${fieldName} must be a positive safe integer (>= 1)`);
  }
  return value;
}

function resolveOverflowPolicy(
  policy: WsBackpressureOverflowPolicy | undefined,
): WsBackpressureOverflowPolicy {
  if (policy === undefined) {
    return "drop-oldest";
  }
  if (!VALID_OVERFLOW_POLICIES.has(policy)) {
    throw new RangeError(
      `overflowPolicy must be one of "drop-oldest", "drop-newest", or "error", got ${String(policy)}`,
    );
  }
  return policy;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export interface KovanicaWsClientOptions {
  /** Full WebSocket URL of the Kovanica RPC endpoint (e.g. "ws://127.0.0.1:8545/ws"). */
  url: string;
  /** Whether to automatically reconnect with exponential backoff on unexpected close. Default: false. */
  reconnect?: boolean;
  /** Initial reconnect delay in milliseconds. Default: 1000. */
  reconnectDelayMs?: number;
  /** Maximum reconnect delay in milliseconds for exponential backoff. Default: 30000. */
  maxReconnectDelayMs?: number;
  /** Injectable WebSocket constructor (defaults to globalThis.WebSocket). */
  WebSocketImpl?: typeof WebSocket;
  /** Timeout in milliseconds for subscribe/unsubscribe RPC requests. Default: 10000. */
  requestTimeoutMs?: number;
  /**
   * Optional interval in milliseconds between JSON-RPC liveness probes.
   * Disabled by default (`0` / `undefined`). When set to a positive number, periodically
   * sends `heartbeatMethod` while connected to detect half-open TCP drops.
   */
  heartbeatIntervalMs?: number;
  /**
   * Maximum time in milliseconds to wait for a message/response after sending a heartbeat
   * probe before force-closing the socket and triggering reconnection. Default: 5000.
   */
  heartbeatTimeoutMs?: number;
  /**
   * Lightweight JSON-RPC method sent for periodic heartbeat liveness probes.
   * Default: `"kovanica_chainId"`.
   */
  heartbeatMethod?: string;
  /**
   * Maximum number of pending notifications buffered per subscription when an async
   * subscription callback is still running. Must be a positive safe integer. Default: 256.
   */
  maxQueueSize?: number;
  /** Alias for `maxQueueSize`. */
  maxPendingQueue?: number;
  /**
   * Backpressure policy when a subscription's pending queue reaches `maxQueueSize`.
   * Default: `"drop-oldest"`.
   */
  overflowPolicy?: WsBackpressureOverflowPolicy;
  /** Optional telemetry callback invoked whenever a notification is dropped due to backpressure. */
  onBackpressureDrop?: (event: WsBackpressureDropEvent) => void;
  /** Optional error hook for asynchronous transport, protocol, or callback errors. */
  onError?: (error: Error) => void;
}

/** Optional filter for `logs` subscriptions. */
export interface WsLogFilter {
  /** Single address or list of addresses to filter logs by. */
  address?: string | string[];
  /** Positional topic filters (each position may be a topic string, array of alternatives, or null wildcard). */
  topics?: Array<string | string[] | null>;
}

/** Raw block payload delivered by `newHeads` subscriptions. */
export interface WsNewHeadEvent {
  hash: string;
  digest?: string;
  author?: number;
  number?: string | number;
  round?: string | number;
  parents?: string[];
  transactions?: unknown[];
  statements?: string;
  signature?: string;
  [key: string]: unknown;
}

/** Committed leader sub-DAG payload delivered by `newCommittedLeader` subscriptions. */
export interface WsCommittedLeaderEvent {
  leader: WsNewHeadEvent;
  leaderRound: number | string;
  leaderAuthor: number;
  blocks: WsNewHeadEvent[];
}

/** Individual contract execution event inside a `logs` receipt. */
export interface WsExecutionEvent {
  address: string | number[];
  topic: string | number[];
  data: string | number[];
  [key: string]: unknown;
}

/** Transaction execution receipt delivered in `logs` subscription arrays. */
export interface WsLogReceipt {
  tx_hash: string;
  success: boolean;
  gas_used: number | string;
  error: string | null;
  events: WsExecutionEvent[];
  [key: string]: unknown;
}

/** JSON-RPC 2.0 subscription notification envelope. */
export interface WsSubscriptionNotification<TResult = unknown> {
  jsonrpc: "2.0";
  method: "kovanica_subscription" | "eth_subscription";
  params: {
    subscription: string;
    result: TResult;
  };
}

export type WsSubscriptionCallback<T = unknown> = (event: T) => void | Promise<void>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveSubscription {
  clientId: string;
  serverId: string;
  params: unknown[];
  callback: (result: unknown) => void | Promise<void>;
  active: boolean;
  draining: boolean;
  pendingQueue: unknown[];
}

export class KovanicaWsClient {
  readonly url: string;
  private readonly reconnectEnabled: boolean;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly webSocketImpl?: typeof WebSocket;
  private readonly requestTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly heartbeatMethod: string;
  private readonly _maxQueueSize: number;
  private readonly overflowPolicy: WsBackpressureOverflowPolicy;
  private readonly onBackpressureDrop?: (event: WsBackpressureDropEvent) => void;
  private readonly onError?: (error: Error) => void;

  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private closedByUser = false;
  private idCounter = 1;
  private reconnectAttempt = 0;
  private _droppedCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatIntervalTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly heartbeatRequestIds = new Set<number>();
  private readonly subscriptionsByClientId = new Map<string, ActiveSubscription>();
  private readonly subscriptionsByServerId = new Map<string, ActiveSubscription>();

  constructor(options: KovanicaWsClientOptions) {
    if (!options.url || options.url.trim().length === 0) {
      throw new Error("WebSocket client requires a non-empty URL");
    }
    if (
      options.heartbeatIntervalMs !== undefined &&
      (!Number.isFinite(options.heartbeatIntervalMs) || options.heartbeatIntervalMs < 0)
    ) {
      throw new RangeError("heartbeatIntervalMs must be a non-negative finite number");
    }
    if (
      options.heartbeatTimeoutMs !== undefined &&
      (!Number.isFinite(options.heartbeatTimeoutMs) || options.heartbeatTimeoutMs <= 0)
    ) {
      throw new RangeError("heartbeatTimeoutMs must be a positive finite number");
    }
    if (options.heartbeatMethod !== undefined && options.heartbeatMethod.trim().length === 0) {
      throw new Error("heartbeatMethod must be a non-empty string");
    }
    if (options.maxQueueSize !== undefined) {
      resolvePositiveSafeIntegerOption(
        options.maxQueueSize,
        DEFAULT_WS_MAX_QUEUE_SIZE,
        "maxQueueSize",
      );
    }
    if (options.maxPendingQueue !== undefined) {
      resolvePositiveSafeIntegerOption(
        options.maxPendingQueue,
        DEFAULT_WS_MAX_QUEUE_SIZE,
        "maxPendingQueue",
      );
    }
    if (
      options.onBackpressureDrop !== undefined &&
      typeof options.onBackpressureDrop !== "function"
    ) {
      throw new TypeError("onBackpressureDrop must be a function when provided");
    }

    this.url = options.url.trim();
    this.reconnectEnabled = options.reconnect ?? false;
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    this.webSocketImpl = options.WebSocketImpl;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 0;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.heartbeatMethod = options.heartbeatMethod?.trim() ?? DEFAULT_HEARTBEAT_METHOD;
    this._maxQueueSize =
      options.maxQueueSize ?? options.maxPendingQueue ?? DEFAULT_WS_MAX_QUEUE_SIZE;
    this.overflowPolicy = resolveOverflowPolicy(options.overflowPolicy);
    this.onBackpressureDrop = options.onBackpressureDrop;
    this.onError = options.onError;
  }

  /** True when the underlying WebSocket is currently open. */
  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  /** Number of currently tracked active subscriptions. */
  get activeSubscriptionCount(): number {
    return this.subscriptionsByClientId.size;
  }

  /** Configured per-subscription maximum backpressure queue capacity. */
  get maxQueueSize(): number {
    return this._maxQueueSize;
  }

  /** Cumulative number of subscription notifications dropped due to backpressure. */
  get droppedCount(): number {
    return this._droppedCount;
  }

  /** Total number of notifications currently buffered across all active subscriptions. */
  get pendingQueueSize(): number {
    let total = 0;
    for (const sub of this.subscriptionsByClientId.values()) {
      total += sub.pendingQueue.length;
    }
    return total;
  }

  /**
   * Opens the WebSocket connection. Resolves when the socket enters the OPEN state.
   * Safe to call multiple times: returns immediately if already connected, or awaits
   * an in-flight connection attempt.
   */
  connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    const WsCtor = this.webSocketImpl ?? globalThis.WebSocket;
    if (typeof WsCtor !== "function") {
      return Promise.reject(
        new KovanicaTransportError(
          "No WebSocket implementation available. Provide WebSocketImpl in options.",
        ),
      );
    }

    this.closedByUser = false;
    this.clearReconnectTimer();
    this.clearHeartbeatTimers();

    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let socket: WebSocket;
      try {
        socket = new WsCtor(this.url);
      } catch (err) {
        reject(
          new KovanicaTransportError(
            `Failed to create WebSocket: ${sanitizeDiagnostics(err instanceof Error ? err.message : String(err))}`,
            { cause: err },
          ),
        );
        return;
      }

      this.ws = socket;

      socket.onopen = () => {
        if (this.ws !== socket) return;
        this.connectPromise = null;
        this.reconnectAttempt = 0;
        this.scheduleNextHeartbeat();
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      socket.onmessage = (event: MessageEvent) => {
        if (this.ws !== socket) return;
        this.handleMessage(event);
      };

      socket.onerror = (event: Event) => {
        if (this.ws !== socket) return;
        const transportErr = new KovanicaTransportError("WebSocket connection error", {
          cause: event,
        });
        if (!settled) {
          settled = true;
          this.connectPromise = null;
          this.clearHeartbeatTimers();
          this.detachSocket(socket);
          this.ws = null;
          reject(transportErr);
        } else {
          this.emitError(transportErr);
        }
      };

      socket.onclose = (event: CloseEvent) => {
        if (this.ws !== socket) return;
        this.clearHeartbeatTimers();
        this.detachSocket(socket);
        this.ws = null;
        this.connectPromise = null;

        if (!settled) {
          settled = true;
          reject(
            new KovanicaTransportError(
              `WebSocket closed before open (code ${event?.code ?? 1006})`,
              { cause: event },
            ),
          );
          return;
        }

        this.rejectAllPending(
          new KovanicaTransportError(
            this.closedByUser
              ? "WebSocket connection closed"
              : `WebSocket connection closed unexpectedly (code ${event?.code ?? 1006})`,
          ),
        );

        if (!this.closedByUser && this.reconnectEnabled) {
          this.scheduleReconnect();
        }
      };
    });

    this.connectPromise = promise;
    return promise;
  }

  /**
   * Closes the WebSocket connection, cancels any pending reconnect timers,
   * rejects all in-flight RPC requests, and clears local subscription state.
   */
  close(): void {
    this.closedByUser = true;
    this.clearReconnectTimer();
    this.clearHeartbeatTimers();
    this.connectPromise = null;

    this.rejectAllPending(new KovanicaTransportError("WebSocket connection closed"));
    for (const sub of this.subscriptionsByClientId.values()) {
      sub.active = false;
      sub.pendingQueue.length = 0;
    }
    this.subscriptionsByClientId.clear();
    this.subscriptionsByServerId.clear();

    const socket = this.ws;
    this.ws = null;
    if (socket) {
      this.detachSocket(socket);
      if (socket.readyState !== WS_CLOSING && socket.readyState !== WS_CLOSED) {
        try {
          socket.close();
        } catch {
          // Ignore errors from closing an already-closing socket
        }
      }
    }
  }

  /**
   * Subscribes to newly produced or accepted DAG blocks (`newHeads`).
   * Returns the subscription ID.
   */
  async subscribeNewHeads(cb: WsSubscriptionCallback<WsNewHeadEvent>): Promise<string> {
    return this.subscribe(["newHeads"], cb as WsSubscriptionCallback<unknown>);
  }

  /**
   * Subscribes to committed leader sub-DAGs (`newCommittedLeader`).
   * Returns the subscription ID.
   */
  async subscribeCommittedLeaders(
    cb: WsSubscriptionCallback<WsCommittedLeaderEvent>,
  ): Promise<string> {
    return this.subscribe(["newCommittedLeader"], cb as WsSubscriptionCallback<unknown>);
  }

  /**
   * Subscribes to transaction execution logs / receipts (`logs`), optionally filtered
   * by contract address(es) and/or topics.
   * Returns the subscription ID.
   */
  async subscribeLogs(
    filter: WsLogFilter | null | undefined,
    cb: WsSubscriptionCallback<WsLogReceipt[]>,
  ): Promise<string> {
    const params: unknown[] = filter != null ? ["logs", filter] : ["logs"];
    return this.subscribe(params, cb as WsSubscriptionCallback<unknown>);
  }

  /**
   * Subscribes to `newHeads` and enriches each incoming block head with its transaction receipts
   * fetched via `rpcClient` using bounded concurrency and a capped backpressure queue.
   */
  async subscribeNewBlocksWithReceipts(
    rpcClient: BlockReceiptsRpcClient,
    onBlock: (event: BlockWithReceiptsEvent) => void | Promise<void>,
    options?: SubscribeNewBlocksWithReceiptsOptions,
  ): Promise<BlockWithReceiptsSubscriptionHandle> {
    return subscribeNewBlocksWithReceipts(this, rpcClient, onBlock, options);
  }

  /**
   * Unsubscribes from an active subscription by ID.
   * Returns `true` if the server confirmed the subscription was removed.
   */
  async unsubscribe(subscriptionId: string): Promise<boolean> {
    const sub =
      this.subscriptionsByClientId.get(subscriptionId) ??
      this.subscriptionsByServerId.get(subscriptionId);

    const targetServerId = sub ? sub.serverId : subscriptionId;

    if (sub) {
      sub.active = false;
      sub.pendingQueue.length = 0;
      this.subscriptionsByClientId.delete(sub.clientId);
      this.subscriptionsByServerId.delete(sub.serverId);
    }

    const result = await this.sendRpc<boolean>("kovanica_unsubscribe", [targetServerId]);
    return Boolean(result);
  }

  // ==========================================================================
  // Internal Subscription & RPC Helpers
  // ==========================================================================

  private async subscribe(
    params: unknown[],
    callback: WsSubscriptionCallback<unknown>,
  ): Promise<string> {
    const serverId = await this.sendRpc<string>("kovanica_subscribe", params);
    if (typeof serverId !== "string" || serverId.length === 0) {
      throw new KovanicaTransportError(
        "Invalid subscription response: expected non-empty subscription ID string",
      );
    }

    const entry: ActiveSubscription = {
      clientId: serverId,
      serverId,
      params,
      callback,
      active: true,
      draining: false,
      pendingQueue: [],
    };
    this.subscriptionsByClientId.set(entry.clientId, entry);
    this.subscriptionsByServerId.set(entry.serverId, entry);
    return entry.clientId;
  }

  private sendRpc<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    const socket = this.ws;
    if (!socket || socket.readyState !== WS_OPEN) {
      return Promise.reject(new KovanicaTransportError("WebSocket is not connected"));
    }

    const id = this.idCounter++;
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      id,
    };
    if (params !== undefined) {
      req.params = params;
    }

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new KovanicaTimeoutError(this.requestTimeoutMs));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        socket.send(JSON.stringify(req));
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(
          new KovanicaTransportError(
            `Failed to send WebSocket message: ${sanitizeDiagnostics(err instanceof Error ? err.message : String(err))}`,
            { cause: err },
          ),
        );
      }
    });
  }

  private handleMessage(event: MessageEvent): void {
    const rawData = event.data;
    let text: string;
    if (typeof rawData === "string") {
      text = rawData;
    } else if (rawData instanceof ArrayBuffer) {
      text = new TextDecoder().decode(rawData);
    } else if (ArrayBuffer.isView(rawData)) {
      text = new TextDecoder().decode(rawData);
    } else {
      this.emitError(new KovanicaTransportError("Unsupported WebSocket message payload type"));
      return;
    }

    let parsed: unknown;
    try {
      parsed = parseLosslessJson(text);
    } catch (err) {
      this.emitError(
        new KovanicaTransportError("Malformed JSON frame from WebSocket RPC server", {
          cause: err,
        }),
      );
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.emitError(
        new KovanicaTransportError(
          "Invalid JSON-RPC 2.0 frame: payload must be a JSON object",
        ),
      );
      return;
    }

    const record = parsed as Record<string, unknown>;
    if (record.jsonrpc !== "2.0") {
      this.emitError(
        new KovanicaTransportError(
          `Invalid JSON-RPC 2.0 frame: missing or invalid "jsonrpc" version`,
        ),
      );
      return;
    }

    // Any valid JSON-RPC 2.0 message from the server confirms socket liveness
    if (this.heartbeatIntervalMs > 0 && this.isConnected) {
      this.scheduleNextHeartbeat();
    }

    // Push notification: { jsonrpc: "2.0", method: "kovanica_subscription", params: { subscription, result } }
    if (
      (record.method === "kovanica_subscription" || record.method === "eth_subscription") &&
      record.params &&
      typeof record.params === "object" &&
      !Array.isArray(record.params)
    ) {
      const params = record.params as { subscription?: unknown; result?: unknown };
      if (typeof params.subscription === "string") {
        const sub = this.subscriptionsByServerId.get(params.subscription);
        if (sub && sub.active) {
          this.dispatchSubscriptionEvent(sub, params.result);
        }
      }
      return;
    }

    // JSON-RPC response correlated by request ID
    const rpcRes = record as Partial<JsonRpcResponse>;
    if (typeof rpcRes.id !== "number") {
      if (rpcRes.error && typeof rpcRes.error === "object") {
        const errObj = rpcRes.error as { code?: unknown; message?: unknown; data?: unknown };
        if (typeof errObj.code === "number" && typeof errObj.message === "string") {
          this.emitError(new KovanicaRpcError(errObj.code, errObj.message, errObj.data));
        }
      }
      return;
    }

    // Consume heartbeat probe responses silently
    if (this.heartbeatRequestIds.delete(rpcRes.id)) {
      return;
    }

    const pending = this.pendingRequests.get(rpcRes.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingRequests.delete(rpcRes.id);

    if (rpcRes.error !== undefined) {
      if (
        typeof rpcRes.error !== "object" ||
        rpcRes.error === null ||
        typeof rpcRes.error.code !== "number" ||
        typeof rpcRes.error.message !== "string"
      ) {
        pending.reject(
          new KovanicaTransportError("Invalid JSON-RPC 2.0 response: malformed error object"),
        );
        return;
      }
      pending.reject(
        new KovanicaRpcError(rpcRes.error.code, rpcRes.error.message, rpcRes.error.data),
      );
      return;
    }

    if (rpcRes.result === undefined) {
      pending.reject(
        new KovanicaTransportError(
          "Invalid JSON-RPC 2.0 response: neither result nor error member present",
        ),
      );
      return;
    }

    pending.resolve(rpcRes.result);
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = Math.min(
      this.reconnectDelayMs * Math.pow(2, this.reconnectAttempt),
      this.maxReconnectDelayMs,
    );
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByUser) return;

      void this.connect()
        .then(() => this.resubscribeAll())
        .catch((err) => {
          this.emitError(err instanceof Error ? err : new Error(String(err)));
          if (!this.closedByUser && this.reconnectEnabled) {
            this.scheduleReconnect();
          }
        });
    }, delay);
  }

  private async resubscribeAll(): Promise<void> {
    this.subscriptionsByServerId.clear();
    const entries = Array.from(this.subscriptionsByClientId.values());

    for (const entry of entries) {
      if (this.closedByUser || !this.isConnected) {
        return;
      }
      try {
        const newServerId = await this.sendRpc<string>("kovanica_subscribe", entry.params);
        if (typeof newServerId !== "string" || newServerId.length === 0) {
          throw new KovanicaTransportError(
            "Invalid re-subscription response: expected non-empty subscription ID string",
          );
        }
        // Verify caller did not unsubscribe while re-subscribing
        if (!this.subscriptionsByClientId.has(entry.clientId)) {
          void this.sendRpc<boolean>("kovanica_unsubscribe", [newServerId]).catch(() => {});
          continue;
        }
        entry.serverId = newServerId;
        this.subscriptionsByServerId.set(newServerId, entry);
      } catch (err) {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(id);
      pending.reject(error);
    }
  }

  private detachSocket(socket: WebSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleNextHeartbeat(): void {
    this.clearHeartbeatTimers();
    if (this.heartbeatIntervalMs <= 0 || this.closedByUser || !this.isConnected) {
      return;
    }
    const socket = this.ws;
    if (!socket) return;

    this.heartbeatIntervalTimer = setTimeout(() => {
      this.heartbeatIntervalTimer = null;
      this.sendHeartbeatProbe(socket);
    }, this.heartbeatIntervalMs);
  }

  private sendHeartbeatProbe(socket: WebSocket): void {
    if (this.closedByUser || this.ws !== socket || socket.readyState !== WS_OPEN) {
      return;
    }

    const id = this.idCounter++;
    this.heartbeatRequestIds.add(id);
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      method: this.heartbeatMethod,
      params: [],
      id,
    };

    this.heartbeatTimeoutTimer = setTimeout(() => {
      this.heartbeatTimeoutTimer = null;
      this.handleHeartbeatTimeout(socket);
    }, this.heartbeatTimeoutMs);

    try {
      socket.send(JSON.stringify(req));
    } catch (err) {
      this.handleHeartbeatTimeout(socket, err);
    }
  }

  private handleHeartbeatTimeout(socket: WebSocket, cause?: unknown): void {
    if (this.ws !== socket || this.closedByUser) {
      return;
    }
    this.clearHeartbeatTimers();
    this.heartbeatRequestIds.clear();

    const err = new KovanicaTransportError(
      `WebSocket heartbeat timed out after ${this.heartbeatTimeoutMs}ms`,
      cause !== undefined ? { cause } : undefined,
    );
    this.emitError(err);

    this.detachSocket(socket);
    this.ws = null;
    this.connectPromise = null;

    if (socket.readyState !== WS_CLOSING && socket.readyState !== WS_CLOSED) {
      try {
        socket.close(4000, "Heartbeat timeout");
      } catch {
        // Ignore errors when force-closing a half-open socket
      }
    }

    this.rejectAllPending(err);

    if (!this.closedByUser && this.reconnectEnabled) {
      this.scheduleReconnect();
    }
  }

  private clearHeartbeatTimers(): void {
    if (this.heartbeatIntervalTimer !== null) {
      clearTimeout(this.heartbeatIntervalTimer);
      this.heartbeatIntervalTimer = null;
    }
    if (this.heartbeatTimeoutTimer !== null) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private dispatchSubscriptionEvent(sub: ActiveSubscription, payload: unknown): void {
    if (!sub.active) {
      return;
    }

    if (sub.draining) {
      if (sub.pendingQueue.length < this._maxQueueSize) {
        sub.pendingQueue.push(payload);
        return;
      }

      this._droppedCount += 1;
      if (this.overflowPolicy === "drop-oldest") {
        const droppedItem = sub.pendingQueue.shift();
        sub.pendingQueue.push(payload);
        this.emitBackpressureDrop({
          policy: "drop-oldest",
          subscriptionId: sub.clientId,
          droppedItem,
          queueSize: sub.pendingQueue.length,
          maxQueueSize: this._maxQueueSize,
          droppedCount: this._droppedCount,
        });
        return;
      }

      const policy = this.overflowPolicy;
      this.emitBackpressureDrop({
        policy,
        subscriptionId: sub.clientId,
        droppedItem: payload,
        queueSize: sub.pendingQueue.length,
        maxQueueSize: this._maxQueueSize,
        droppedCount: this._droppedCount,
      });

      if (policy === "error") {
        this.emitError(
          new KovanicaTransportError(
            `WebSocket subscription backpressure queue overflow (maxQueueSize=${this._maxQueueSize})`,
          ),
        );
      }
      return;
    }

    let result: void | Promise<void>;
    try {
      result = sub.callback(payload);
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (isPromiseLike(result)) {
      sub.draining = true;
      void Promise.resolve(result)
        .catch((err) => {
          this.emitError(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          void this.drainSubscriptionQueue(sub);
        });
    }
  }

  private async drainSubscriptionQueue(sub: ActiveSubscription): Promise<void> {
    try {
      while (sub.active && sub.pendingQueue.length > 0) {
        const nextPayload = sub.pendingQueue.shift();
        try {
          const res = sub.callback(nextPayload);
          if (isPromiseLike(res)) {
            await res;
          }
        } catch (err) {
          this.emitError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    } finally {
      sub.draining = false;
    }
  }

  private emitBackpressureDrop(event: WsBackpressureDropEvent): void {
    if (!this.onBackpressureDrop) {
      return;
    }
    try {
      this.onBackpressureDrop(event);
    } catch {
      // Never allow telemetry hooks to crash WebSocket message dispatch
    }
  }

  private emitError(error: Error): void {
    if (this.onError) {
      this.onError(error);
    }
  }
}

// ============================================================================
// Typed Block + Receipt Stream (`subscribeNewBlocksWithReceipts`)
// ============================================================================

/** Minimal WebSocket client interface required by {@link subscribeNewBlocksWithReceipts}. */
export interface SubscribeNewHeadsWsClient {
  subscribeNewHeads(cb: WsSubscriptionCallback<WsNewHeadEvent>): Promise<string>;
  unsubscribe(subscriptionId: string): Promise<boolean>;
}

/** Minimal JSON-RPC client interface required by {@link subscribeNewBlocksWithReceipts}. */
export interface BlockReceiptsRpcClient {
  getTransactionReceipt(
    hash: string,
    options?: RequestOptions,
  ): Promise<TransactionReceipt | null>;
  getBlockByHash?(
    hash: string,
    fullTransactions?: boolean,
    options?: RequestOptions,
  ): Promise<BlockResponse | null>;
}

/** Diagnostic context passed alongside errors reported via `options.onError`. */
export interface BlockReceiptErrorContext {
  stage: "block" | "receipt" | "callback" | "backpressure" | "unsubscribe";
  head?: WsNewHeadEvent;
  txHash?: string;
}

/** Enriched block event delivered to `onBlock` by {@link subscribeNewBlocksWithReceipts}. */
export interface BlockWithReceiptsEvent {
  /** Raw block head received from the `newHeads` WebSocket subscription. */
  head: WsNewHeadEvent;
  /** Optional full block fetched via `getBlockByHash` when `head.transactions` was omitted. */
  block?: BlockResponse | null;
  /** Transaction receipts fetched for this block, in deterministic transaction order. */
  receipts: TransactionReceipt[];
  /** Number of incoming block heads dropped due to backpressure immediately before this block. */
  droppedBeforeThis: number;
}

/** Options for {@link subscribeNewBlocksWithReceipts}. */
export interface SubscribeNewBlocksWithReceiptsOptions {
  /**
   * Maximum number of pending block heads buffered while a previous block is being
   * enriched/processed. Must be a positive safe integer. Default: 256.
   */
  maxQueueSize?: number;
  /** Alias for `maxQueueSize`. */
  maxPendingQueue?: number;
  /**
   * Backpressure policy applied when a new block head arrives while the pending queue is full.
   * - `"drop-oldest"` (default): evict the oldest buffered head and enqueue the newest.
   * - `"drop-newest"`: discard the newly arrived head.
   * - `"error"`: discard the newly arrived head and invoke `onError` with a `KovanicaTransportError`.
   */
  overflowPolicy?: WsBackpressureOverflowPolicy;
  /**
   * Maximum number of concurrent `getTransactionReceipt` RPC calls per block.
   * Must be a positive safe integer. Default: 8.
   */
  receiptConcurrency?: number;
  /**
   * When `true` (default) and an incoming `newHeads` payload omits `transactions`,
   * attempts to fetch the block transaction list via `rpcClient.getBlockByHash`.
   */
  fetchMissingBlock?: boolean;
  /** Optional per-request options (`timeoutMs`, `signal`) forwarded to RPC calls. */
  requestOptions?: RequestOptions;
  /** Optional `AbortSignal` that unsubscribes and cancels in-flight receipt fetches when aborted. */
  signal?: AbortSignal;
  /**
   * Optional error handler invoked for block/receipt fetch errors, backpressure `"error"` policy
   * overflows, or `onBlock` callback failures. Errors are isolated and never crash the loop.
   */
  onError?: (error: Error, context?: BlockReceiptErrorContext) => void;
  /** Optional telemetry callback invoked whenever a block head is dropped due to backpressure. */
  onBackpressureDrop?: (event: WsBackpressureDropEvent<WsNewHeadEvent>) => void;
}

/** Active subscription handle returned by {@link subscribeNewBlocksWithReceipts}. */
export interface BlockWithReceiptsSubscriptionHandle {
  /** Subscription ID returned by `wsClient.subscribeNewHeads`. */
  subscriptionId: string;
  /** Cumulative number of block heads dropped due to backpressure. */
  readonly droppedCount: number;
  /** Current number of block heads waiting in the backpressure queue. */
  readonly pendingCount: number;
  /** Unsubscribes from `newHeads`, aborts in-flight receipt fetches, and clears buffered heads. */
  unsubscribe: () => Promise<boolean>;
}

interface QueuedBlockHead {
  head: WsNewHeadEvent;
  droppedBefore: number;
}

function extractTransactionHash(entry: unknown): string | null {
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const record = entry as { hash?: unknown; tx_hash?: unknown };
    if (typeof record.hash === "string" && record.hash.trim().length > 0) {
      return record.hash.trim();
    }
    if (typeof record.tx_hash === "string" && record.tx_hash.trim().length > 0) {
      return record.tx_hash.trim();
    }
  }
  return null;
}

function extractTransactionHashesFromList(transactions: ReadonlyArray<unknown>): string[] {
  const hashes: string[] = [];
  for (const tx of transactions) {
    const hash = extractTransactionHash(tx);
    if (hash !== null) {
      hashes.push(hash);
    }
  }
  return hashes;
}

function createCombinedBlockRequestOptions(
  stopSignal: AbortSignal,
  requestOptions: RequestOptions | undefined,
): { options: RequestOptions; cleanup: () => void } {
  const reqSignal = requestOptions?.signal;
  if (!reqSignal || reqSignal === stopSignal) {
    return {
      options: { ...requestOptions, signal: stopSignal },
      cleanup: () => {},
    };
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (stopSignal.aborted || reqSignal.aborted) {
    controller.abort();
  } else {
    stopSignal.addEventListener("abort", onAbort, { once: true });
    reqSignal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    options: { ...requestOptions, signal: controller.signal },
    cleanup: () => {
      stopSignal.removeEventListener("abort", onAbort);
      reqSignal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Subscribes to live block heads (`newHeads`) via `wsClient`, enriches each block with its
 * transaction receipts fetched via `rpcClient` using bounded concurrency and a capped
 * backpressure queue, and delivers `{ head, receipts, droppedBeforeThis }` to `onBlock`
 * in arrival order.
 */
export async function subscribeNewBlocksWithReceipts(
  wsClient: SubscribeNewHeadsWsClient,
  rpcClient: BlockReceiptsRpcClient,
  onBlock: (event: BlockWithReceiptsEvent) => void | Promise<void>,
  options?: SubscribeNewBlocksWithReceiptsOptions,
): Promise<BlockWithReceiptsSubscriptionHandle> {
  if (
    !wsClient ||
    typeof wsClient !== "object" ||
    typeof wsClient.subscribeNewHeads !== "function" ||
    typeof wsClient.unsubscribe !== "function"
  ) {
    throw new TypeError(
      "subscribeNewBlocksWithReceipts: wsClient must implement subscribeNewHeads() and unsubscribe()",
    );
  }
  if (
    !rpcClient ||
    typeof rpcClient !== "object" ||
    typeof rpcClient.getTransactionReceipt !== "function"
  ) {
    throw new TypeError(
      "subscribeNewBlocksWithReceipts: rpcClient must implement getTransactionReceipt()",
    );
  }
  if (typeof onBlock !== "function") {
    throw new TypeError("subscribeNewBlocksWithReceipts: onBlock callback must be a function");
  }
  if (options !== undefined && (options === null || typeof options !== "object")) {
    throw new TypeError("subscribeNewBlocksWithReceipts: options must be an object when provided");
  }

  if (options?.maxQueueSize !== undefined) {
    resolvePositiveSafeIntegerOption(
      options.maxQueueSize,
      DEFAULT_WS_MAX_QUEUE_SIZE,
      "maxQueueSize",
    );
  }
  if (options?.maxPendingQueue !== undefined) {
    resolvePositiveSafeIntegerOption(
      options.maxPendingQueue,
      DEFAULT_WS_MAX_QUEUE_SIZE,
      "maxPendingQueue",
    );
  }
  const maxQueueSize =
    options?.maxQueueSize ?? options?.maxPendingQueue ?? DEFAULT_WS_MAX_QUEUE_SIZE;
  const overflowPolicy = resolveOverflowPolicy(options?.overflowPolicy);
  const receiptConcurrency = resolvePositiveSafeIntegerOption(
    options?.receiptConcurrency,
    DEFAULT_BLOCK_RECEIPT_CONCURRENCY,
    "receiptConcurrency",
  );
  const fetchMissingBlock = options?.fetchMissingBlock ?? true;

  if (options?.onError !== undefined && typeof options.onError !== "function") {
    throw new TypeError("subscribeNewBlocksWithReceipts: onError must be a function when provided");
  }
  if (
    options?.onBackpressureDrop !== undefined &&
    typeof options.onBackpressureDrop !== "function"
  ) {
    throw new TypeError(
      "subscribeNewBlocksWithReceipts: onBackpressureDrop must be a function when provided",
    );
  }

  const externalSignal = options?.signal;
  if (externalSignal?.aborted) {
    throw new KovanicaAbortError("subscribeNewBlocksWithReceipts: subscription was aborted");
  }

  const onError = options?.onError;
  const onBackpressureDrop = options?.onBackpressureDrop;
  const stopController = new AbortController();

  let active = true;
  let processing = false;
  let totalDropped = 0;
  let pendingDropsAfterTail = 0;
  let subscriptionId = "";
  let unsubscribePromise: Promise<boolean> | null = null;
  const queue: QueuedBlockHead[] = [];

  const reportError = (err: unknown, context: BlockReceiptErrorContext): void => {
    if (!onError) {
      return;
    }
    const normalized = err instanceof Error ? err : new Error(String(err));
    try {
      onError(normalized, context);
    } catch {
      // Never allow an error hook failure to crash the subscription loop
    }
  };

  const reportBackpressureDrop = (droppedItem: WsNewHeadEvent): void => {
    if (!onBackpressureDrop) {
      return;
    }
    try {
      onBackpressureDrop({
        policy: overflowPolicy,
        ...(subscriptionId ? { subscriptionId } : {}),
        droppedItem,
        queueSize: queue.length,
        maxQueueSize,
        droppedCount: totalDropped,
      });
    } catch {
      // Never allow telemetry hooks to crash the subscription loop
    }
  };

  const fetchReceiptsForBlock = async (
    head: WsNewHeadEvent,
  ): Promise<{ block?: BlockResponse | null; receipts: TransactionReceipt[] }> => {
    const { options: reqOpts, cleanup } = createCombinedBlockRequestOptions(
      stopController.signal,
      options?.requestOptions,
    );

    try {
      let block: BlockResponse | null | undefined;
      let txHashes: string[] = [];

      if (Array.isArray(head.transactions)) {
        txHashes = extractTransactionHashesFromList(head.transactions);
      } else if (
        fetchMissingBlock &&
        typeof rpcClient.getBlockByHash === "function"
      ) {
        const blockHash =
          typeof head.hash === "string" && head.hash.trim().length > 0
            ? head.hash.trim()
            : typeof head.digest === "string" && head.digest.trim().length > 0
              ? head.digest.trim()
              : null;

        if (blockHash !== null && active && !stopController.signal.aborted) {
          try {
            block = await rpcClient.getBlockByHash(blockHash, false, reqOpts);
            if (block && Array.isArray(block.transactions)) {
              txHashes = extractTransactionHashesFromList(block.transactions);
            }
          } catch (err) {
            if (active && !stopController.signal.aborted) {
              reportError(err, { stage: "block", head });
            }
            return { ...(block !== undefined ? { block } : {}), receipts: [] };
          }
        }
      }

      if (txHashes.length === 0 || !active || stopController.signal.aborted) {
        return { ...(block !== undefined ? { block } : {}), receipts: [] };
      }

      const orderedReceipts: Array<TransactionReceipt | null> = new Array(txHashes.length).fill(
        null,
      );
      let nextIndex = 0;
      const workerCount = Math.min(receiptConcurrency, txHashes.length);

      const worker = async (): Promise<void> => {
        while (active && !stopController.signal.aborted) {
          const idx = nextIndex;
          if (idx >= txHashes.length) {
            return;
          }
          nextIndex += 1;

          const txHash = txHashes[idx]!;
          try {
            const receipt = await rpcClient.getTransactionReceipt(txHash, reqOpts);
            orderedReceipts[idx] = receipt ?? null;
          } catch (err) {
            if (active && !stopController.signal.aborted) {
              reportError(err, { stage: "receipt", head, txHash });
            }
          }
        }
      };

      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      const receipts: TransactionReceipt[] = [];
      for (const receipt of orderedReceipts) {
        if (receipt !== null) {
          receipts.push(receipt);
        }
      }

      return { ...(block !== undefined ? { block } : {}), receipts };
    } finally {
      cleanup();
    }
  };

  const processEntry = async (entry: QueuedBlockHead): Promise<void> => {
    if (!active || stopController.signal.aborted) {
      return;
    }

    const { block, receipts } = await fetchReceiptsForBlock(entry.head);
    if (!active || stopController.signal.aborted) {
      return;
    }

    const event: BlockWithReceiptsEvent = {
      head: entry.head,
      ...(block !== undefined ? { block } : {}),
      receipts,
      droppedBeforeThis: entry.droppedBefore,
    };

    try {
      await onBlock(event);
    } catch (err) {
      if (active && !stopController.signal.aborted) {
        reportError(err, { stage: "callback", head: entry.head });
      }
    }
  };

  const drainQueue = async (): Promise<void> => {
    if (processing) {
      return;
    }
    processing = true;
    try {
      while (active && !stopController.signal.aborted && queue.length > 0) {
        const nextEntry = queue.shift()!;
        await processEntry(nextEntry);
      }
    } finally {
      processing = false;
      if (active && !stopController.signal.aborted && queue.length > 0) {
        void drainQueue();
      }
    }
  };

  const handleIncomingHead = (head: WsNewHeadEvent): void => {
    if (!active || stopController.signal.aborted) {
      return;
    }

    if (!processing && queue.length === 0) {
      const immediateEntry: QueuedBlockHead = {
        head,
        droppedBefore: pendingDropsAfterTail,
      };
      pendingDropsAfterTail = 0;
      processing = true;
      void processEntry(immediateEntry).finally(() => {
        processing = false;
        if (active && !stopController.signal.aborted && queue.length > 0) {
          void drainQueue();
        }
      });
      return;
    }

    if (queue.length < maxQueueSize) {
      queue.push({ head, droppedBefore: pendingDropsAfterTail });
      pendingDropsAfterTail = 0;
      if (!processing) {
        void drainQueue();
      }
      return;
    }

    totalDropped += 1;

    if (overflowPolicy === "drop-oldest") {
      const evicted = queue.shift()!;
      const carriedDrops = evicted.droppedBefore + 1;
      if (queue.length > 0) {
        queue[0]!.droppedBefore += carriedDrops;
        queue.push({ head, droppedBefore: pendingDropsAfterTail });
      } else {
        queue.push({ head, droppedBefore: carriedDrops + pendingDropsAfterTail });
      }
      pendingDropsAfterTail = 0;
      reportBackpressureDrop(evicted.head);
      return;
    }

    pendingDropsAfterTail += 1;
    reportBackpressureDrop(head);

    if (overflowPolicy === "error") {
      reportError(
        new KovanicaTransportError(
          `Block receipt subscription backpressure queue overflow (maxQueueSize=${maxQueueSize})`,
        ),
        { stage: "backpressure", head },
      );
    }
  };

  const onExternalAbort = (): void => {
    void unsubscribe().catch((err) => {
      reportError(err, { stage: "unsubscribe" });
    });
  };

  const unsubscribe = (): Promise<boolean> => {
    if (unsubscribePromise) {
      return unsubscribePromise;
    }
    active = false;
    queue.length = 0;
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
    stopController.abort();

    if (!subscriptionId) {
      unsubscribePromise = Promise.resolve(false);
      return unsubscribePromise;
    }

    unsubscribePromise = wsClient.unsubscribe(subscriptionId);
    return unsubscribePromise;
  };

  if (externalSignal) {
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    subscriptionId = await wsClient.subscribeNewHeads(handleIncomingHead);
  } catch (err) {
    active = false;
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
    stopController.abort();
    throw err;
  }

  if (stopController.signal.aborted) {
    await wsClient.unsubscribe(subscriptionId).catch(() => {});
    throw new KovanicaAbortError("subscribeNewBlocksWithReceipts: subscription was aborted");
  }

  return {
    subscriptionId,
    get droppedCount(): number {
      return totalDropped;
    },
    get pendingCount(): number {
      return queue.length;
    },
    unsubscribe,
  };
}
