import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KovanicaAbortError,
  KovanicaRpcError,
  KovanicaTimeoutError,
  KovanicaTransportError,
  RpcErrorCode,
} from "../src/errors";
import type { BlockResponse, RequestOptions, TransactionReceipt } from "../src/types";
import {
  DEFAULT_BLOCK_RECEIPT_CONCURRENCY,
  DEFAULT_WS_MAX_QUEUE_SIZE,
  KovanicaWsClient,
  type BlockReceiptErrorContext,
  type BlockReceiptsRpcClient,
  type BlockWithReceiptsEvent,
  type WsBackpressureDropEvent,
  type WsCommittedLeaderEvent,
  type WsLogReceipt,
  type WsNewHeadEvent,
  subscribeNewBlocksWithReceipts,
} from "../src/ws";

/**
 * Minimal in-memory WebSocket mock compatible with `typeof WebSocket`.
 */
class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: MockWebSocket[] = [];
  static autoOpen = true;
  static onCreate?: (ws: MockWebSocket) => void;

  readonly url: string;
  readyState: number = MockWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalled = false;

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    MockWebSocket.onCreate?.(this);
    if (MockWebSocket.autoOpen) {
      queueMicrotask(() => {
        if (this.readyState === MockWebSocket.CONNECTING) {
          this.triggerOpen();
        }
      });
    }
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("Socket is not open");
    }
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.closeCalled = true;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  triggerOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  triggerMessage(payload: unknown): void {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.onmessage?.({ data } as MessageEvent);
  }

  triggerError(err: unknown = new Error("socket error")): void {
    this.onerror?.(err as Event);
  }

  triggerServerClose(code = 1006, reason = "abnormal"): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  lastSentJson(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

const MockWsCtor = MockWebSocket as unknown as typeof WebSocket;

describe("KovanicaWsClient", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    MockWebSocket.autoOpen = true;
    MockWebSocket.onCreate = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("validates non-empty URL on construction", () => {
    expect(() => new KovanicaWsClient({ url: "", WebSocketImpl: MockWsCtor })).toThrow(
      /non-empty URL/,
    );
    expect(() => new KovanicaWsClient({ url: "   ", WebSocketImpl: MockWsCtor })).toThrow(
      /non-empty URL/,
    );
  });

  it("connects, deduplicates concurrent connect calls, and reports isConnected", async () => {
    MockWebSocket.autoOpen = false;
    const client = new KovanicaWsClient({
      url: "ws://127.0.0.1:8545/ws",
      WebSocketImpl: MockWsCtor,
    });

    expect(client.isConnected).toBe(false);

    const p1 = client.connect();
    const p2 = client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe("ws://127.0.0.1:8545/ws");

    MockWebSocket.instances[0].triggerOpen();
    await Promise.all([p1, p2]);

    expect(client.isConnected).toBe(true);

    // Subsequent connect() when already open resolves immediately without new socket
    await client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);

    client.close();
    expect(client.isConnected).toBe(false);
  });

  it("rejects connect() with KovanicaTransportError on socket error before open", async () => {
    MockWebSocket.autoOpen = false;
    const client = new KovanicaWsClient({
      url: "ws://127.0.0.1:8545/ws",
      WebSocketImpl: MockWsCtor,
    });

    const p = client.connect();
    MockWebSocket.instances[0].triggerError();

    await expect(p).rejects.toThrow(KovanicaTransportError);
    expect(client.isConnected).toBe(false);
  });

  it("subscribes to newHeads, committedLeaders, and logs, and dispatches notifications", async () => {
    const client = new KovanicaWsClient({
      url: "ws://127.0.0.1:8545/ws",
      WebSocketImpl: MockWsCtor,
    });
    await client.connect();
    const ws = MockWebSocket.instances[0];

    const heads: WsNewHeadEvent[] = [];
    const leaders: WsCommittedLeaderEvent[] = [];
    const logBatches: WsLogReceipt[][] = [];

    // Issue all three subscriptions concurrently to verify ID correlation
    const pHeads = client.subscribeNewHeads((ev) => heads.push(ev));
    const pLeaders = client.subscribeCommittedLeaders((ev) => leaders.push(ev));
    const pLogs = client.subscribeLogs(
      { address: "kvnc111dag", topics: ["transfer"] },
      (ev) => logBatches.push(ev),
    );

    expect(ws.sent).toHaveLength(3);
    const req1 = JSON.parse(ws.sent[0]);
    const req2 = JSON.parse(ws.sent[1]);
    const req3 = JSON.parse(ws.sent[2]);

    expect(req1).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "kovanica_subscribe",
      params: ["newHeads"],
    });
    expect(req2).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "kovanica_subscribe",
      params: ["newCommittedLeader"],
    });
    expect(req3).toEqual({
      jsonrpc: "2.0",
      id: 3,
      method: "kovanica_subscribe",
      params: ["logs", { address: "kvnc111dag", topics: ["transfer"] }],
    });

    // Respond out of order to verify strict ID correlation
    ws.triggerMessage({ jsonrpc: "2.0", id: 3, result: "0x3" });
    ws.triggerMessage({ jsonrpc: "2.0", id: 1, result: "0x1" });
    ws.triggerMessage({ jsonrpc: "2.0", id: 2, result: "0x2" });

    const [subHeads, subLeaders, subLogs] = await Promise.all([pHeads, pLeaders, pLogs]);
    expect(subHeads).toBe("0x1");
    expect(subLeaders).toBe("0x2");
    expect(subLogs).toBe("0x3");
    expect(client.activeSubscriptionCount).toBe(3);

    // Emit notifications matching subscriptions.rs envelope
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: "kovanica_subscription",
      params: { subscription: "0x1", result: { hash: "0xhead1", round: "0x10" } },
    });
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: "kovanica_subscription",
      params: {
        subscription: "0x2",
        result: {
          leader: { hash: "0xleader1" },
          leaderRound: 16,
          leaderAuthor: 1,
          blocks: [{ hash: "0xleader1" }],
        },
      },
    });
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: "kovanica_subscription",
      params: {
        subscription: "0x3",
        result: [
          {
            tx_hash: "0xtx1",
            success: true,
            gas_used: 21000,
            error: null,
            events: [{ address: "kvnc111dag", topic: "transfer", data: [1, 2] }],
          },
        ],
      },
    });

    expect(heads).toEqual([{ hash: "0xhead1", round: "0x10" }]);
    expect(leaders).toHaveLength(1);
    expect(leaders[0].leaderRound).toBe(16);
    expect(logBatches).toHaveLength(1);
    expect(logBatches[0][0].tx_hash).toBe("0xtx1");

    client.close();
  });

  it("supports subscribeLogs with undefined/null filter", async () => {
    const client = new KovanicaWsClient({
      url: "ws://127.0.0.1:8545/ws",
      WebSocketImpl: MockWsCtor,
    });
    await client.connect();
    const ws = MockWebSocket.instances[0];

    const p = client.subscribeLogs(undefined, () => {});
    expect(ws.lastSentJson()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "kovanica_subscribe",
      params: ["logs"],
    });
    ws.triggerMessage({ jsonrpc: "2.0", id: 1, result: "0x1" });
    await expect(p).resolves.toBe("0x1");

    client.close();
  });

  it("unsubscribes and stops dispatching notifications", async () => {
    const client = new KovanicaWsClient({
      url: "ws://127.0.0.1:8545/ws",
      WebSocketImpl: MockWsCtor,
    });
    await client.connect();
    const ws = MockWebSocket.instances[0];

    const cb = vi.fn();
    const subPromise = client.subscribeNewHeads(cb);
    ws.triggerMessage({ jsonrpc: "2.0", id: 1, result: "0x1" });
    const subId = await subPromise;

    ws.triggerMessage({
      jsonrpc: "2.0",
      method: "kovanica_subscription",
      params: { subscription: "0x1", result: { hash: "0xfirst" } },
    });
    expect(cb).toHaveBeenCalledTimes(1);

    const unsubPromise = client.unsubscribe(subId);
    expect(ws.lastSentJson()).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "kovanica_unsubscribe",
      params: ["0x1"],
    });
    ws.triggerMessage({ jsonrpc: "2.0", id: 2, result: true });
    await expect(unsubPromise).resolves.toBe(true);
    expect(client.activeSubscriptionCount).toBe(0);

    // Subsequent notifications for 0x1 must not be delivered
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: "kovanica_subscription",
      params: { subscription: "0x1", result: { hash: "0xsecond" } },
    });
    expect(cb).toHaveBeenCalledTimes(1);

    client.close();
  });

  it("propagates KovanicaRpcError, KovanicaTransportError, and KovanicaTimeoutError", async () => {
    const errors: Error[] = [];
    const client = new KovanicaWsClient({
      url: "ws://127.0.0.1:8545/ws",
      WebSocketImpl: MockWsCtor,
      requestTimeoutMs: 50,
      onError: (err) => errors.push(err),
    });

    // Calling subscribe before connect rejects with KovanicaTransportError
    await expect(client.subscribeNewHeads(() => {})).rejects.toThrow(KovanicaTransportError);

    await client.connect();
    const ws = MockWebSocket.instances[0];

    // RPC error propagation
    const errSub = client.subscribeNewHeads(() => {});
    ws.triggerMessage({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: RpcErrorCode.InvalidParams,
        message: "subscribe: unsupported subscription",
      },
    });

    try {
      await errSub;
      expect.fail("Expected KovanicaRpcError");
    } catch (err) {
      expect(err).toBeInstanceOf(KovanicaRpcError);
      const rpcErr = err as KovanicaRpcError;
      expect(rpcErr.code).toBe(RpcErrorCode.InvalidParams);
      expect(rpcErr.isInvalidParams()).toBe(true);
    }

    // Malformed JSON frame invokes onError without crashing
    ws.triggerMessage("{not-valid-json");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(KovanicaTransportError);

    // Timeout rejects with KovanicaTimeoutError
    const timeoutSub = client.subscribeNewHeads(() => {});
    await expect(timeoutSub).rejects.toThrow(KovanicaTimeoutError);

    client.close();
  });

  it("cleans up pending requests, subscriptions, and socket on close()", async () => {
    const client = new KovanicaWsClient({
      url: "ws://127.0.0.1:8545/ws",
      WebSocketImpl: MockWsCtor,
      reconnect: true,
    });
    await client.connect();
    const ws = MockWebSocket.instances[0];

    const subPromise = client.subscribeNewHeads(() => {});
    ws.triggerMessage({ jsonrpc: "2.0", id: 1, result: "0x1" });
    await subPromise;
    expect(client.activeSubscriptionCount).toBe(1);

    // Start an in-flight request that will not be answered before close()
    const inflight = client.subscribeCommittedLeaders(() => {});

    client.close();

    await expect(inflight).rejects.toThrow(KovanicaTransportError);
    expect(client.isConnected).toBe(false);
    expect(client.activeSubscriptionCount).toBe(0);
    expect(ws.closeCalled).toBe(true);
  });

  it("reconnects with exponential backoff and automatically re-subscribes with remapped IDs", async () => {
    vi.useFakeTimers();
    MockWebSocket.autoOpen = false;

    const client = new KovanicaWsClient({
      url: "ws://127.0.0.1:8545/ws",
      WebSocketImpl: MockWsCtor,
      reconnect: true,
      reconnectDelayMs: 100,
      maxReconnectDelayMs: 250,
    });

    const connectP = client.connect();
    const ws1 = MockWebSocket.instances[0];
    ws1.triggerOpen();
    await connectP;

    const headCb = vi.fn();
    const logsCb = vi.fn();

    const p1 = client.subscribeNewHeads(headCb);
    const p2 = client.subscribeLogs({ topics: ["mint"] }, logsCb);
    ws1.triggerMessage({ jsonrpc: "2.0", id: 1, result: "0x1" });
    ws1.triggerMessage({ jsonrpc: "2.0", id: 2, result: "0x2" });
    const [origHeadId, origLogsId] = await Promise.all([p1, p2]);

    // Simulate unexpected disconnect from server
    ws1.triggerServerClose(1006, "connection lost");
    expect(client.isConnected).toBe(false);

    // First reconnect attempt after 100ms — make it fail to test exponential backoff
    await vi.advanceTimersByTimeAsync(99);
    expect(MockWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(2);
    const ws2 = MockWebSocket.instances[1];
    ws2.triggerError();

    // Second reconnect attempt should wait 200ms (100 * 2^1)
    await vi.advanceTimersByTimeAsync(199);
    expect(MockWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(3);
    const ws3 = MockWebSocket.instances[2];
    ws3.triggerError();

    // Third reconnect attempt should be capped at maxReconnectDelayMs (250ms, not 400ms)
    await vi.advanceTimersByTimeAsync(249);
    expect(MockWebSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(4);
    const ws4 = MockWebSocket.instances[3];

    // Open ws4 and respond to sequential re-subscriptions with NEW server IDs
    ws4.triggerOpen();
    await Promise.resolve();
    await Promise.resolve();

    expect(ws4.sent).toHaveLength(1);
    const resub1 = JSON.parse(ws4.sent[0]);
    expect(resub1.method).toBe("kovanica_subscribe");
    expect(resub1.params).toEqual(["newHeads"]);
    ws4.triggerMessage({ jsonrpc: "2.0", id: resub1.id, result: "0xa1" });

    await Promise.resolve();
    await Promise.resolve();

    expect(ws4.sent).toHaveLength(2);
    const resub2 = JSON.parse(ws4.sent[1]);
    expect(resub2.method).toBe("kovanica_subscribe");
    expect(resub2.params).toEqual(["logs", { topics: ["mint"] }]);
    ws4.triggerMessage({ jsonrpc: "2.0", id: resub2.id, result: "0xa2" });

    await Promise.resolve();
    await Promise.resolve();

    // Notifications using the NEW server IDs must dispatch to the original callbacks
    ws4.triggerMessage({
      jsonrpc: "2.0",
      method: "kovanica_subscription",
      params: { subscription: "0xa1", result: { hash: "0xreconnected-head" } },
    });
    ws4.triggerMessage({
      jsonrpc: "2.0",
      method: "kovanica_subscription",
      params: {
        subscription: "0xa2",
        result: [{ tx_hash: "0xmint", success: true, gas_used: 100, error: null, events: [] }],
      },
    });

    expect(headCb).toHaveBeenCalledWith({ hash: "0xreconnected-head" });
    expect(logsCb).toHaveBeenCalledTimes(1);

    // Unsubscribing with the ORIGINAL client ID must send the NEW server ID ("0xa1")
    const unsubP = client.unsubscribe(origHeadId);
    const unsubReq = ws4.lastSentJson();
    expect(unsubReq.method).toBe("kovanica_unsubscribe");
    expect(unsubReq.params).toEqual(["0xa1"]);
    ws4.triggerMessage({ jsonrpc: "2.0", id: unsubReq.id, result: true });
    await expect(unsubP).resolves.toBe(true);

    expect(client.activeSubscriptionCount).toBe(1);
    expect(origLogsId).toBe("0x2");

    client.close();
  });

  describe("heartbeat & idle liveness detection", () => {
    it("validates heartbeat configuration options on construction", () => {
      expect(
        () =>
          new KovanicaWsClient({
            url: "ws://127.0.0.1:8545/ws",
            WebSocketImpl: MockWsCtor,
            heartbeatIntervalMs: -1,
          }),
      ).toThrow(RangeError);

      expect(
        () =>
          new KovanicaWsClient({
            url: "ws://127.0.0.1:8545/ws",
            WebSocketImpl: MockWsCtor,
            heartbeatTimeoutMs: 0,
          }),
      ).toThrow(RangeError);

      expect(
        () =>
          new KovanicaWsClient({
            url: "ws://127.0.0.1:8545/ws",
            WebSocketImpl: MockWsCtor,
            heartbeatMethod: "   ",
          }),
      ).toThrow(/heartbeatMethod must be a non-empty string/);
    });

    it("periodically sends heartbeat liveness probes and stays connected when responses arrive in time", async () => {
      vi.useFakeTimers();
      MockWebSocket.autoOpen = false;
      const errors: Error[] = [];

      const client = new KovanicaWsClient({
        url: "ws://127.0.0.1:8545/ws",
        WebSocketImpl: MockWsCtor,
        heartbeatIntervalMs: 1_000,
        heartbeatTimeoutMs: 300,
        onError: (err) => errors.push(err),
      });

      const connectP = client.connect();
      const ws = MockWebSocket.instances[0];
      ws.triggerOpen();
      await connectP;

      // Before heartbeatIntervalMs elapses, no probe is sent
      await vi.advanceTimersByTimeAsync(999);
      expect(ws.sent).toHaveLength(0);

      // At 1000ms, first probe is sent using default method "kovanica_chainId"
      await vi.advanceTimersByTimeAsync(1);
      expect(ws.sent).toHaveLength(1);
      const probe1 = JSON.parse(ws.sent[0]);
      expect(probe1).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "kovanica_chainId",
        params: [],
      });

      // Server responds within heartbeatTimeoutMs (after 150ms)
      await vi.advanceTimersByTimeAsync(150);
      ws.triggerMessage({ jsonrpc: "2.0", id: probe1.id, result: "0x1" });

      // Advancing past the original 300ms timeout window does not disconnect
      await vi.advanceTimersByTimeAsync(200);
      expect(client.isConnected).toBe(true);
      expect(errors).toHaveLength(0);

      // Next probe is scheduled 1000ms after the response arrived (200ms already elapsed, 800ms remaining)
      await vi.advanceTimersByTimeAsync(799);
      expect(ws.sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(ws.sent).toHaveLength(2);
      const probe2 = JSON.parse(ws.sent[1]);
      expect(probe2.method).toBe("kovanica_chainId");
      expect(probe2.id).toBe(2);

      // Incoming push notification also satisfies liveness and resets the timeout
      await vi.advanceTimersByTimeAsync(100);
      ws.triggerMessage({
        jsonrpc: "2.0",
        method: "kovanica_subscription",
        params: { subscription: "0xsub", result: { hash: "0xabc" } },
      });
      await vi.advanceTimersByTimeAsync(300);
      expect(client.isConnected).toBe(true);
      expect(errors).toHaveLength(0);

      client.close();
    });

    it("detects half-open stall on heartbeat timeout, force-closes socket, and triggers reconnect + re-subscription", async () => {
      vi.useFakeTimers();
      MockWebSocket.autoOpen = false;
      const errors: Error[] = [];

      const client = new KovanicaWsClient({
        url: "ws://127.0.0.1:8545/ws",
        WebSocketImpl: MockWsCtor,
        reconnect: true,
        reconnectDelayMs: 100,
        heartbeatIntervalMs: 500,
        heartbeatTimeoutMs: 200,
        heartbeatMethod: "kovanica_blockNumber",
        onError: (err) => errors.push(err),
      });

      const connectP = client.connect();
      const ws1 = MockWebSocket.instances[0];
      ws1.triggerOpen();
      await connectP;

      const headsCb = vi.fn();
      const subP = client.subscribeNewHeads(headsCb);
      const subReq = ws1.lastSentJson();
      ws1.triggerMessage({ jsonrpc: "2.0", id: subReq.id, result: "0xsub1" });
      await subP;

      // Advance 500ms after the last message so the heartbeat probe is sent
      await vi.advanceTimersByTimeAsync(500);
      expect(ws1.sent).toHaveLength(2);
      const probeReq = ws1.lastSentJson();
      expect(probeReq.method).toBe("kovanica_blockNumber");

      // Simulate half-open stall: no response arrives within heartbeatTimeoutMs (200ms)
      await vi.advanceTimersByTimeAsync(199);
      expect(client.isConnected).toBe(true);
      expect(ws1.closeCalled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(client.isConnected).toBe(false);
      expect(ws1.closeCalled).toBe(true);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(KovanicaTransportError);
      expect(errors[0].message).toMatch(/heartbeat timed out after 200ms/);

      // Reconnect timer fires after reconnectDelayMs (100ms)
      await vi.advanceTimersByTimeAsync(100);
      expect(MockWebSocket.instances).toHaveLength(2);
      const ws2 = MockWebSocket.instances[1];
      ws2.triggerOpen();
      await Promise.resolve();
      await Promise.resolve();

      expect(client.isConnected).toBe(true);
      expect(ws2.sent).toHaveLength(1);
      const resubReq = JSON.parse(ws2.sent[0]);
      expect(resubReq.method).toBe("kovanica_subscribe");
      expect(resubReq.params).toEqual(["newHeads"]);
      ws2.triggerMessage({ jsonrpc: "2.0", id: resubReq.id, result: "0xsub2" });

      await Promise.resolve();
      await Promise.resolve();

      // Verify notifications work on the recovered socket
      ws2.triggerMessage({
        jsonrpc: "2.0",
        method: "kovanica_subscription",
        params: { subscription: "0xsub2", result: { hash: "0xrecovered" } },
      });
      expect(headsCb).toHaveBeenCalledWith({ hash: "0xrecovered" });

      client.close();
    });

    it("cleanly clears heartbeat interval and timeout timers on close()", async () => {
      vi.useFakeTimers();
      MockWebSocket.autoOpen = false;
      const errors: Error[] = [];

      const client = new KovanicaWsClient({
        url: "ws://127.0.0.1:8545/ws",
        WebSocketImpl: MockWsCtor,
        reconnect: true,
        reconnectDelayMs: 50,
        heartbeatIntervalMs: 400,
        heartbeatTimeoutMs: 150,
        onError: (err) => errors.push(err),
      });

      const connectP = client.connect();
      const ws = MockWebSocket.instances[0];
      ws.triggerOpen();
      await connectP;

      // Let the probe fire so heartbeatTimeoutTimer is active, then immediately close()
      await vi.advanceTimersByTimeAsync(400);
      expect(ws.sent).toHaveLength(1);

      client.close();

      // Advancing far past heartbeatTimeoutMs and reconnectDelayMs must not emit errors or reconnect
      await vi.advanceTimersByTimeAsync(5_000);
      expect(errors).toHaveLength(0);
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(client.isConnected).toBe(false);
    });
  });

  describe("backpressure queue cap", () => {
    function createDeferred<T = void>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    } {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it("validates backpressure options on construction and exposes defaults", () => {
      const defaultClient = new KovanicaWsClient({
        url: "ws://127.0.0.1:8545/ws",
        WebSocketImpl: MockWsCtor,
      });
      expect(defaultClient.maxQueueSize).toBe(DEFAULT_WS_MAX_QUEUE_SIZE);
      expect(defaultClient.droppedCount).toBe(0);
      expect(defaultClient.pendingQueueSize).toBe(0);

      const aliasClient = new KovanicaWsClient({
        url: "ws://127.0.0.1:8545/ws",
        WebSocketImpl: MockWsCtor,
        maxPendingQueue: 16,
      });
      expect(aliasClient.maxQueueSize).toBe(16);

      expect(
        () =>
          new KovanicaWsClient({
            url: "ws://127.0.0.1:8545/ws",
            WebSocketImpl: MockWsCtor,
            maxQueueSize: 0,
          }),
      ).toThrow(RangeError);

      expect(
        () =>
          new KovanicaWsClient({
            url: "ws://127.0.0.1:8545/ws",
            WebSocketImpl: MockWsCtor,
            maxPendingQueue: -5,
          }),
      ).toThrow(RangeError);

      expect(
        () =>
          new KovanicaWsClient({
            url: "ws://127.0.0.1:8545/ws",
            WebSocketImpl: MockWsCtor,
            overflowPolicy: "invalid" as unknown as "drop-oldest",
          }),
      ).toThrow(RangeError);
    });

    it("caps pending queue with drop-oldest policy for slow async consumers", async () => {
      const drops: WsBackpressureDropEvent[] = [];
      const client = new KovanicaWsClient({
        url: "ws://127.0.0.1:8545/ws",
        WebSocketImpl: MockWsCtor,
        maxQueueSize: 2,
        overflowPolicy: "drop-oldest",
        onBackpressureDrop: (ev) => drops.push(ev),
      });
      await client.connect();
      const ws = MockWebSocket.instances[0];

      const gate = createDeferred();
      const received: string[] = [];
      const subP = client.subscribeNewHeads(async (head) => {
        received.push(head.hash);
        if (head.hash === "0x1") {
          await gate.promise;
        }
      });
      ws.triggerMessage({ jsonrpc: "2.0", id: 1, result: "0xsub" });
      await subP;

      for (const hash of ["0x1", "0x2", "0x3", "0x4", "0x5"]) {
        ws.triggerMessage({
          jsonrpc: "2.0",
          method: "kovanica_subscription",
          params: { subscription: "0xsub", result: { hash } },
        });
      }

      // 0x1 is in-flight, queue holds [0x4, 0x5], 0x2 and 0x3 were dropped
      expect(client.pendingQueueSize).toBe(2);
      expect(client.droppedCount).toBe(2);
      expect(drops).toHaveLength(2);
      expect((drops[0].droppedItem as WsNewHeadEvent).hash).toBe("0x2");
      expect((drops[1].droppedItem as WsNewHeadEvent).hash).toBe("0x3");
      expect(drops[1].policy).toBe("drop-oldest");
      expect(drops[1].droppedCount).toBe(2);

      gate.resolve();
      await vi.waitFor(() => expect(received).toEqual(["0x1", "0x4", "0x5"]));
      expect(client.pendingQueueSize).toBe(0);

      client.close();
    });

    it("caps pending queue with drop-newest and error policies", async () => {
      const dropsNewest: WsBackpressureDropEvent[] = [];
      const clientNewest = new KovanicaWsClient({
        url: "ws://127.0.0.1:8545/ws",
        WebSocketImpl: MockWsCtor,
        maxQueueSize: 2,
        overflowPolicy: "drop-newest",
        onBackpressureDrop: (ev) => dropsNewest.push(ev),
      });
      await clientNewest.connect();
      const ws1 = MockWebSocket.instances[0];

      const gate1 = createDeferred();
      const received1: string[] = [];
      const subP1 = clientNewest.subscribeNewHeads(async (head) => {
        received1.push(head.hash);
        if (head.hash === "0x1") {
          await gate1.promise;
        }
      });
      ws1.triggerMessage({ jsonrpc: "2.0", id: 1, result: "0xsub1" });
      await subP1;

      for (const hash of ["0x1", "0x2", "0x3", "0x4", "0x5"]) {
        ws1.triggerMessage({
          jsonrpc: "2.0",
          method: "kovanica_subscription",
          params: { subscription: "0xsub1", result: { hash } },
        });
      }

      expect(clientNewest.droppedCount).toBe(2);
      expect(dropsNewest.map((d) => (d.droppedItem as WsNewHeadEvent).hash)).toEqual(["0x4", "0x5"]);

      gate1.resolve();
      await vi.waitFor(() => expect(received1).toEqual(["0x1", "0x2", "0x3"]));
      clientNewest.close();

      // Error overflow policy emits KovanicaTransportError via onError
      const errors: Error[] = [];
      const clientErr = new KovanicaWsClient({
        url: "ws://127.0.0.1:8545/ws",
        WebSocketImpl: MockWsCtor,
        maxQueueSize: 1,
        overflowPolicy: "error",
        onError: (err) => errors.push(err),
      });
      await clientErr.connect();
      const ws2 = MockWebSocket.instances[1];

      const gate2 = createDeferred();
      const subP2 = clientErr.subscribeNewHeads(async (head) => {
        if (head.hash === "0xa") {
          await gate2.promise;
        }
      });
      ws2.triggerMessage({ jsonrpc: "2.0", id: 1, result: "0xsub2" });
      await subP2;

      for (const hash of ["0xa", "0xb", "0xc"]) {
        ws2.triggerMessage({
          jsonrpc: "2.0",
          method: "kovanica_subscription",
          params: { subscription: "0xsub2", result: { hash } },
        });
      }

      expect(clientErr.droppedCount).toBe(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(KovanicaTransportError);
      expect(errors[0].message).toMatch(/backpressure queue overflow/i);

      gate2.resolve();
      clientErr.close();
    });
  });

  describe("subscribeNewBlocksWithReceipts", () => {
    function makeReceipt(txHash: string, blockHash: string, idx: number): TransactionReceipt {
      return {
        transactionHash: txHash,
        blockHash,
        blockNumber: 42n,
        transactionIndex: BigInt(idx),
        status: 1,
        success: true,
        gasUsed: 21_000n,
      };
    }

    function createDeferred<T = void>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    } {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it("validates arguments and pre-aborted AbortSignal fail-closed", async () => {
      const wsClient = {
        subscribeNewHeads: vi.fn().mockResolvedValue("0x1"),
        unsubscribe: vi.fn().mockResolvedValue(true),
      };
      const rpcClient: BlockReceiptsRpcClient = {
        getTransactionReceipt: vi.fn().mockResolvedValue(null),
      };

      await expect(
        subscribeNewBlocksWithReceipts(null as never, rpcClient, () => {}),
      ).rejects.toThrow(TypeError);
      await expect(
        subscribeNewBlocksWithReceipts(wsClient, {} as never, () => {}),
      ).rejects.toThrow(TypeError);
      await expect(
        subscribeNewBlocksWithReceipts(wsClient, rpcClient, null as never),
      ).rejects.toThrow(TypeError);
      await expect(
        subscribeNewBlocksWithReceipts(wsClient, rpcClient, () => {}, { maxQueueSize: 0 }),
      ).rejects.toThrow(RangeError);
      await expect(
        subscribeNewBlocksWithReceipts(wsClient, rpcClient, () => {}, { receiptConcurrency: 0 }),
      ).rejects.toThrow(RangeError);

      const aborted = new AbortController();
      aborted.abort();
      await expect(
        subscribeNewBlocksWithReceipts(wsClient, rpcClient, () => {}, {
          signal: aborted.signal,
        }),
      ).rejects.toThrow(KovanicaAbortError);
      expect(wsClient.subscribeNewHeads).not.toHaveBeenCalled();
      expect(DEFAULT_BLOCK_RECEIPT_CONCURRENCY).toBeGreaterThan(0);
    });

    it("streams enriched blocks with receipts in deterministic order and bounded concurrency", async () => {
      const client = new KovanicaWsClient({
        url: "ws://127.0.0.1:8545/ws",
        WebSocketImpl: MockWsCtor,
      });
      await client.connect();
      const ws = MockWebSocket.instances[0];

      let inFlight = 0;
      let maxInFlight = 0;
      const receiptDeferreds = new Map<string, ReturnType<typeof createDeferred<TransactionReceipt | null>>>();

      const rpcClient: BlockReceiptsRpcClient = {
        getTransactionReceipt: vi.fn(async (hash: string) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          const d = createDeferred<TransactionReceipt | null>();
          receiptDeferreds.set(hash, d);
          try {
            return await d.promise;
          } finally {
            inFlight -= 1;
          }
        }),
      };

      const delivered: BlockWithReceiptsEvent[] = [];
      const handleP = client.subscribeNewBlocksWithReceipts(
        rpcClient,
        (ev) => {
          delivered.push(ev);
        },
        { receiptConcurrency: 2 },
      );

      const subReq = ws.lastSentJson();
      expect(subReq.method).toBe("kovanica_subscribe");
      expect(subReq.params).toEqual(["newHeads"]);
      ws.triggerMessage({ jsonrpc: "2.0", id: subReq.id, result: "0xheads" });
      const handle = await handleP;
      expect(handle.subscriptionId).toBe("0xheads");

      // Emit a block with 4 transactions (mixing hash strings and tx objects)
      ws.triggerMessage({
        jsonrpc: "2.0",
        method: "kovanica_subscription",
        params: {
          subscription: "0xheads",
          result: {
            hash: "0xblock1",
            round: 100,
            transactions: ["0xtx0", { hash: "0xtx1" }, { tx_hash: "0xtx2" }, "0xtx3"],
          },
        },
      });

      // Wait until first 2 concurrent fetches are in-flight
      await vi.waitFor(() => expect(receiptDeferreds.size).toBe(2));
      expect(maxInFlight).toBe(2);

      // Resolve tx1 BEFORE tx0 to verify deterministic tx ordering in final receipts array
      receiptDeferreds.get("0xtx1")!.resolve(makeReceipt("0xtx1", "0xblock1", 1));
      await vi.waitFor(() => expect(receiptDeferreds.has("0xtx2")).toBe(true));
      receiptDeferreds.get("0xtx0")!.resolve(makeReceipt("0xtx0", "0xblock1", 0));
      await vi.waitFor(() => expect(receiptDeferreds.has("0xtx3")).toBe(true));
      receiptDeferreds.get("0xtx3")!.resolve(makeReceipt("0xtx3", "0xblock1", 3));
      receiptDeferreds.get("0xtx2")!.resolve(makeReceipt("0xtx2", "0xblock1", 2));

      await vi.waitFor(() => expect(delivered).toHaveLength(1));
      expect(maxInFlight).toBeLessThanOrEqual(2);
      expect(delivered[0].head.hash).toBe("0xblock1");
      expect(delivered[0].droppedBeforeThis).toBe(0);
      expect(delivered[0].receipts.map((r) => r.transactionHash)).toEqual([
        "0xtx0",
        "0xtx1",
        "0xtx2",
        "0xtx3",
      ]);

      client.close();
    });

    it("handles empty blocks with 0 txs without issuing receipt RPC calls", async () => {
      const client = new KovanicaWsClient({
        url: "ws://127.0.0.1:8545/ws",
        WebSocketImpl: MockWsCtor,
      });
      await client.connect();
      const ws = MockWebSocket.instances[0];

      const getReceiptMock = vi.fn();
      const getBlockMock = vi.fn();
      const rpcClient: BlockReceiptsRpcClient = {
        getTransactionReceipt: getReceiptMock,
        getBlockByHash: getBlockMock,
      };

      const delivered: BlockWithReceiptsEvent[] = [];
      const handleP = subscribeNewBlocksWithReceipts(client, rpcClient, (ev) => {
        delivered.push(ev);
      });
      ws.triggerMessage({ jsonrpc: "2.0", id: 1, result: "0xempty" });
      await handleP;

      ws.triggerMessage({
        jsonrpc: "2.0",
        method: "kovanica_subscription",
        params: {
          subscription: "0xempty",
          result: { hash: "0xemptyblock", number: "0x1", transactions: [] },
        },
      });

      await vi.waitFor(() => expect(delivered).toHaveLength(1));
      expect(delivered[0]).toEqual({
        head: { hash: "0xemptyblock", number: "0x1", transactions: [] },
        receipts: [],
        droppedBeforeThis: 0,
      });
      expect(getReceiptMock).not.toHaveBeenCalled();
      expect(getBlockMock).not.toHaveBeenCalled();

      client.close();
    });

    it("fetches missing block via getBlockByHash when newHeads omits transactions", async () => {
      const client = new KovanicaWsClient({
        url: "ws://127.0.0.1:8545/ws",
        WebSocketImpl: MockWsCtor,
      });
      await client.connect();
      const ws = MockWebSocket.instances[0];

      const fullBlock: BlockResponse = {
        hash: "0xheaderonly",
        digest: "0xheaderonly",
        author: 0,
        number: 7n,
        round: 7n,
        parents: [],
        transactions: ["0xtxA"],
        statements: "",
        signature: "0xsig",
      };

      const rpcClient: BlockReceiptsRpcClient = {
        getBlockByHash: vi.fn().mockResolvedValue(fullBlock),
        getTransactionReceipt: vi
          .fn()
          .mockResolvedValue(makeReceipt("0xtxA", "0xheaderonly", 0)),
      };

      const delivered: BlockWithReceiptsEvent[] = [];
      const handleP = subscribeNewBlocksWithReceipts(client, rpcClient, (ev) => {
        delivered.push(ev);
      });
      ws.triggerMessage({ jsonrpc: "2.0", id: 1, result: "0xhdr" });
      await handleP;

      ws.triggerMessage({
        jsonrpc: "2.0",
        method: "kovanica_subscription",
        params: { subscription: "0xhdr", result: { hash: "0xheaderonly", number: 7 } },
      });

      await vi.waitFor(() => expect(delivered).toHaveLength(1));
      expect(rpcClient.getBlockByHash).toHaveBeenCalledWith(
        "0xheaderonly",
        false,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(delivered[0].block).toEqual(fullBlock);
      expect(delivered[0].receipts).toHaveLength(1);
      expect(delivered[0].receipts[0].transactionHash).toBe("0xtxA");

      client.close();
    });

    it("isolates receipt fetch errors via onError without terminating the stream", async () => {
      const client = new KovanicaWsClient({
        url: "ws://127.0.0.1:8545/ws",
        WebSocketImpl: MockWsCtor,
      });
      await client.connect();
      const ws = MockWebSocket.instances[0];

      const rpcClient: BlockReceiptsRpcClient = {
        getTransactionReceipt: vi.fn(async (hash: string) => {
          if (hash === "0xbad") {
            throw new Error("RPC node 503");
          }
          return makeReceipt(hash, "0xblk", 0);
        }),
      };

      const delivered: BlockWithReceiptsEvent[] = [];
      const errors: Array<{ error: Error; context?: BlockReceiptErrorContext }> = [];

      const handleP = subscribeNewBlocksWithReceipts(
        client,
        rpcClient,
        (ev) => {
          delivered.push(ev);
        },
        {
          onError: (error, context) => errors.push({ error, context }),
        },
      );
      ws.triggerMessage({ jsonrpc: "2.0", id: 1, result: "0xerrsub" });
      await handleP;

      ws.triggerMessage({
        jsonrpc: "2.0",
        method: "kovanica_subscription",
        params: {
          subscription: "0xerrsub",
          result: { hash: "0xblk1", transactions: ["0xbad", "0xgood1"] },
        },
      });
      ws.triggerMessage({
        jsonrpc: "2.0",
        method: "kovanica_subscription",
        params: {
          subscription: "0xerrsub",
          result: { hash: "0xblk2", transactions: ["0xgood2"] },
        },
      });

      await vi.waitFor(() => expect(delivered).toHaveLength(2));
      expect(errors).toHaveLength(1);
      expect(errors[0].error.message).toContain("RPC node 503");
      expect(errors[0].context?.stage).toBe("receipt");
      expect(errors[0].context?.txHash).toBe("0xbad");

      expect(delivered[0].head.hash).toBe("0xblk1");
      expect(delivered[0].receipts.map((r) => r.transactionHash)).toEqual(["0xgood1"]);
      expect(delivered[1].head.hash).toBe("0xblk2");
      expect(delivered[1].receipts.map((r) => r.transactionHash)).toEqual(["0xgood2"]);

      client.close();
    });

    it("cleanly unsubscribes, aborts in-flight receipt fetches, and ignores subsequent heads", async () => {
      const client = new KovanicaWsClient({
        url: "ws://127.0.0.1:8545/ws",
        WebSocketImpl: MockWsCtor,
      });
      await client.connect();
      const ws = MockWebSocket.instances[0];

      let capturedSignal: AbortSignal | undefined;
      const pendingReceipt = createDeferred<TransactionReceipt | null>();
      const rpcClient: BlockReceiptsRpcClient = {
        getTransactionReceipt: vi.fn(async (_hash: string, opts?: RequestOptions) => {
          capturedSignal = opts?.signal;
          return pendingReceipt.promise;
        }),
      };

      const delivered: BlockWithReceiptsEvent[] = [];
      const handleP = subscribeNewBlocksWithReceipts(client, rpcClient, (ev) => {
        delivered.push(ev);
      });
      ws.triggerMessage({ jsonrpc: "2.0", id: 1, result: "0xunsub" });
      const handle = await handleP;

      ws.triggerMessage({
        jsonrpc: "2.0",
        method: "kovanica_subscription",
        params: {
          subscription: "0xunsub",
          result: { hash: "0xinflight", transactions: ["0xtx1"] },
        },
      });

      await vi.waitFor(() => expect(capturedSignal).toBeDefined());
      expect(capturedSignal!.aborted).toBe(false);

      const unsubP = handle.unsubscribe();
      const unsubReq = ws.lastSentJson();
      expect(unsubReq.method).toBe("kovanica_unsubscribe");
      expect(unsubReq.params).toEqual(["0xunsub"]);
      ws.triggerMessage({ jsonrpc: "2.0", id: unsubReq.id, result: true });
      await expect(unsubP).resolves.toBe(true);

      // In-flight request signal is aborted and resolving it must NOT deliver to onBlock
      expect(capturedSignal!.aborted).toBe(true);
      pendingReceipt.resolve(makeReceipt("0xtx1", "0xinflight", 0));

      // Idempotent second unsubscribe returns the same result without extra RPC calls
      await expect(handle.unsubscribe()).resolves.toBe(true);
      expect(delivered).toHaveLength(0);

      client.close();
    });

    it("enforces backpressure queue cap with drop-oldest policy and reports droppedBeforeThis", async () => {
      const client = new KovanicaWsClient({
        url: "ws://127.0.0.1:8545/ws",
        WebSocketImpl: MockWsCtor,
      });
      await client.connect();
      const ws = MockWebSocket.instances[0];

      const block1Gate = createDeferred();
      const rpcClient: BlockReceiptsRpcClient = {
        getTransactionReceipt: vi.fn(async (hash: string) => {
          if (hash === "0xtx1") {
            await block1Gate.promise;
          }
          return makeReceipt(hash, "0xblk", 0);
        }),
      };

      const delivered: BlockWithReceiptsEvent[] = [];
      const drops: Array<WsBackpressureDropEvent<WsNewHeadEvent>> = [];
      const handleP = subscribeNewBlocksWithReceipts(
        client,
        rpcClient,
        (ev) => {
          delivered.push(ev);
        },
        {
          maxQueueSize: 2,
          overflowPolicy: "drop-oldest",
          onBackpressureDrop: (ev) => drops.push(ev),
        },
      );
      ws.triggerMessage({ jsonrpc: "2.0", id: 1, result: "0xbp1" });
      const handle = await handleP;

      for (let i = 1; i <= 5; i += 1) {
        ws.triggerMessage({
          jsonrpc: "2.0",
          method: "kovanica_subscription",
          params: {
            subscription: "0xbp1",
            result: { hash: `0xblk${i}`, transactions: [`0xtx${i}`] },
          },
        });
      }

      // blk1 is in-flight; queue capped at 2 holds [blk4, blk5]; blk2 and blk3 dropped
      expect(handle.pendingCount).toBe(2);
      expect(handle.droppedCount).toBe(2);
      expect(drops.map((d) => d.droppedItem.hash)).toEqual(["0xblk2", "0xblk3"]);

      block1Gate.resolve();
      await vi.waitFor(() => expect(delivered).toHaveLength(3));

      expect(delivered.map((d) => d.head.hash)).toEqual(["0xblk1", "0xblk4", "0xblk5"]);
      expect(delivered.map((d) => d.droppedBeforeThis)).toEqual([0, 2, 0]);
      expect(handle.pendingCount).toBe(0);
      expect(handle.droppedCount).toBe(2);

      client.close();
    });

    it("enforces backpressure queue cap with drop-newest policy and tracks dropped count telemetry", async () => {
      const client = new KovanicaWsClient({
        url: "ws://127.0.0.1:8545/ws",
        WebSocketImpl: MockWsCtor,
      });
      await client.connect();
      const ws = MockWebSocket.instances[0];

      const block1Gate = createDeferred();
      const rpcClient: BlockReceiptsRpcClient = {
        getTransactionReceipt: vi.fn(async (hash: string) => {
          if (hash === "0xtx1") {
            await block1Gate.promise;
          }
          return makeReceipt(hash, "0xblk", 0);
        }),
      };

      const delivered: BlockWithReceiptsEvent[] = [];
      const drops: Array<WsBackpressureDropEvent<WsNewHeadEvent>> = [];
      const handleP = subscribeNewBlocksWithReceipts(
        client,
        rpcClient,
        (ev) => {
          delivered.push(ev);
        },
        {
          maxQueueSize: 2,
          overflowPolicy: "drop-newest",
          onBackpressureDrop: (ev) => drops.push(ev),
        },
      );
      ws.triggerMessage({ jsonrpc: "2.0", id: 1, result: "0xbp2" });
      const handle = await handleP;

      for (let i = 1; i <= 5; i += 1) {
        ws.triggerMessage({
          jsonrpc: "2.0",
          method: "kovanica_subscription",
          params: {
            subscription: "0xbp2",
            result: { hash: `0xblk${i}`, transactions: [`0xtx${i}`] },
          },
        });
      }

      expect(handle.pendingCount).toBe(2);
      expect(handle.droppedCount).toBe(2);
      expect(drops.map((d) => d.droppedItem.hash)).toEqual(["0xblk4", "0xblk5"]);
      expect(drops[1].policy).toBe("drop-newest");
      expect(drops[1].droppedCount).toBe(2);

      block1Gate.resolve();
      await vi.waitFor(() => expect(delivered).toHaveLength(3));
      expect(delivered.map((d) => d.head.hash)).toEqual(["0xblk1", "0xblk2", "0xblk3"]);
      expect(delivered.map((d) => d.droppedBeforeThis)).toEqual([0, 0, 0]);

      // Next block arriving after the burst observes the 2 dropped blocks in droppedBeforeThis
      ws.triggerMessage({
        jsonrpc: "2.0",
        method: "kovanica_subscription",
        params: {
          subscription: "0xbp2",
          result: { hash: "0xblk6", transactions: [] },
        },
      });
      await vi.waitFor(() => expect(delivered).toHaveLength(4));
      expect(delivered[3].head.hash).toBe("0xblk6");
      expect(delivered[3].droppedBeforeThis).toBe(2);

      client.close();
    });

    it("reports backpressure error policy overflows via onError and supports AbortSignal", async () => {
      const client = new KovanicaWsClient({
        url: "ws://127.0.0.1:8545/ws",
        WebSocketImpl: MockWsCtor,
      });
      await client.connect();
      const ws = MockWebSocket.instances[0];

      const gate = createDeferred();
      const rpcClient: BlockReceiptsRpcClient = {
        getTransactionReceipt: vi.fn(async () => {
          await gate.promise;
          return null;
        }),
      };

      const errors: Array<{ error: Error; context?: BlockReceiptErrorContext }> = [];
      const controller = new AbortController();

      const handleP = subscribeNewBlocksWithReceipts(
        client,
        rpcClient,
        () => {},
        {
          maxQueueSize: 1,
          overflowPolicy: "error",
          signal: controller.signal,
          onError: (error, context) => errors.push({ error, context }),
        },
      );
      ws.triggerMessage({ jsonrpc: "2.0", id: 1, result: "0xbp3" });
      const handle = await handleP;

      for (const hash of ["0x1", "0x2", "0x3"]) {
        ws.triggerMessage({
          jsonrpc: "2.0",
          method: "kovanica_subscription",
          params: { subscription: "0xbp3", result: { hash, transactions: ["0xtx"] } },
        });
      }

      expect(handle.droppedCount).toBe(1);
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toBeInstanceOf(KovanicaTransportError);
      expect(errors[0].context?.stage).toBe("backpressure");

      // Aborting external signal triggers unsubscribe
      controller.abort();
      const unsubReq = ws.lastSentJson();
      expect(unsubReq.method).toBe("kovanica_unsubscribe");
      expect(unsubReq.params).toEqual(["0xbp3"]);
      ws.triggerMessage({ jsonrpc: "2.0", id: unsubReq.id, result: true });

      gate.resolve();
      client.close();
    });
  });
});
