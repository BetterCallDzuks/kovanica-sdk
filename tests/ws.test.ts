import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KovanicaRpcError,
  KovanicaTimeoutError,
  KovanicaTransportError,
  RpcErrorCode,
} from "../src/errors";
import {
  KovanicaWsClient,
  type WsCommittedLeaderEvent,
  type WsLogReceipt,
  type WsNewHeadEvent,
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
});
