/**
 * Typed WebSocket subscription client for Kovanica JSON-RPC (`GET /ws`).
 *
 * Supports JSON-RPC 2.0 `kovanica_subscribe` / `kovanica_unsubscribe` and
 * `kovanica_subscription` push notifications matching `kovanica-rpc/src/subscriptions.rs`.
 */

import {
  KovanicaRpcError,
  KovanicaTimeoutError,
  KovanicaTransportError,
} from "./errors";
import { parseLosslessJson, sanitizeDiagnostics } from "./transport";
import type { JsonRpcRequest, JsonRpcResponse } from "./types";

const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_METHOD = "kovanica_chainId";

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

export type WsSubscriptionCallback<T = unknown> = (event: T) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveSubscription {
  clientId: string;
  serverId: string;
  params: unknown[];
  callback: (result: unknown) => void;
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
  private readonly onError?: (error: Error) => void;

  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private closedByUser = false;
  private idCounter = 1;
  private reconnectAttempt = 0;
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

    this.url = options.url.trim();
    this.reconnectEnabled = options.reconnect ?? false;
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    this.webSocketImpl = options.WebSocketImpl;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 0;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.heartbeatMethod = options.heartbeatMethod?.trim() ?? DEFAULT_HEARTBEAT_METHOD;
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
   * Unsubscribes from an active subscription by ID.
   * Returns `true` if the server confirmed the subscription was removed.
   */
  async unsubscribe(subscriptionId: string): Promise<boolean> {
    const sub =
      this.subscriptionsByClientId.get(subscriptionId) ??
      this.subscriptionsByServerId.get(subscriptionId);

    const targetServerId = sub ? sub.serverId : subscriptionId;

    if (sub) {
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
        if (sub) {
          try {
            sub.callback(params.result);
          } catch (err) {
            this.emitError(err instanceof Error ? err : new Error(String(err)));
          }
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

  private emitError(error: Error): void {
    if (this.onError) {
      this.onError(error);
    }
  }
}
