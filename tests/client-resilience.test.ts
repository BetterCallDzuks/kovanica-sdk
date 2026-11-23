import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_IDEMPOTENT_RPC_METHODS,
  KovanicaClient,
  computeRetryDelayMs,
} from "../src/client";
import {
  KovanicaAbortError,
  KovanicaRpcError,
  KovanicaTimeoutError,
  KovanicaTransportError,
  RpcErrorCode,
} from "../src/errors";
import type { Transport } from "../src/transport";

function makeJsonRpcOkResponse(id: number | string, result: unknown) {
  const payload = JSON.stringify({ jsonrpc: "2.0", id, result });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => payload,
    json: async () => JSON.parse(payload),
  };
}

function makeJsonRpcErrorResponse(
  id: number | string,
  code: number,
  message: string,
  data?: unknown,
) {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => payload,
    json: async () => JSON.parse(payload),
  };
}

function makeHttpErrorResponse(status: number, statusText: string, body = "") {
  return {
    ok: false,
    status,
    statusText,
    text: async () => body,
  };
}

describe("KovanicaClient resilience: retry, backoff & multi-endpoint failover", () => {
  describe("DEFAULT_IDEMPOTENT_RPC_METHODS & computeRetryDelayMs", () => {
    it("includes canonical idempotent read methods and excludes sendRawTransaction", () => {
      expect(DEFAULT_IDEMPOTENT_RPC_METHODS).toContain("kovanica_call");
      expect(DEFAULT_IDEMPOTENT_RPC_METHODS).toContain("kovanica_getStorageAt");
      expect(DEFAULT_IDEMPOTENT_RPC_METHODS).toContain("kovanica_estimateFee");
      expect(DEFAULT_IDEMPOTENT_RPC_METHODS).toContain("kovanica_blockNumber");
      expect(DEFAULT_IDEMPOTENT_RPC_METHODS).toContain("kovanica_getBalance");
      expect(DEFAULT_IDEMPOTENT_RPC_METHODS).toContain("kovanica_getTransactionReceipt");
      expect(DEFAULT_IDEMPOTENT_RPC_METHODS).toContain("kovanica_getDagTips");
      expect(DEFAULT_IDEMPOTENT_RPC_METHODS).not.toContain("kovanica_sendRawTransaction");
    });

    it("computes bounded jittered exponential backoff delays", () => {
      // Deterministic (jitterRatio = 0)
      expect(
        computeRetryDelayMs(0, { initialDelayMs: 50, maxDelayMs: 500, jitterRatio: 0 }),
      ).toBe(50);
      expect(
        computeRetryDelayMs(1, { initialDelayMs: 50, maxDelayMs: 500, jitterRatio: 0 }),
      ).toBe(100);
      expect(
        computeRetryDelayMs(2, { initialDelayMs: 50, maxDelayMs: 500, jitterRatio: 0 }),
      ).toBe(200);
      expect(
        computeRetryDelayMs(5, { initialDelayMs: 50, maxDelayMs: 500, jitterRatio: 0 }),
      ).toBe(500);

      // Jitter bounds [1 - r, 1 + r] capped at maxDelayMs
      expect(
        computeRetryDelayMs(0, { initialDelayMs: 100, maxDelayMs: 500, jitterRatio: 0.2 }, () => 0),
      ).toBe(80);
      expect(
        computeRetryDelayMs(0, { initialDelayMs: 100, maxDelayMs: 500, jitterRatio: 0.2 }, () => 1),
      ).toBe(120);
      expect(
        computeRetryDelayMs(10, { initialDelayMs: 100, maxDelayMs: 500, jitterRatio: 0.5 }, () => 1),
      ).toBe(500);

      // Zero initial delay
      expect(
        computeRetryDelayMs(2, { initialDelayMs: 0, maxDelayMs: 500, jitterRatio: 0.2 }),
      ).toBe(0);
    });
  });

  describe("endpoint resolution & config validation", () => {
    it("places primary rpcUrl first and deduplicates rpcUrls", () => {
      const client = new KovanicaClient({
        rpcUrl: "http://primary.local/rpc",
        rpcUrls: [
          "http://secondary.local/rpc",
          "http://primary.local/rpc",
          "http://tertiary.local/rpc",
          "http://secondary.local/rpc",
        ],
      });

      expect(client.rpcUrls).toEqual([
        "http://primary.local/rpc",
        "http://secondary.local/rpc",
        "http://tertiary.local/rpc",
      ]);
    });

    it("fails closed when no valid RPC URL or transport is provided", () => {
      expect(() => new KovanicaClient({})).toThrow(/at least one valid RPC URL/i);
      expect(() => new KovanicaClient({ rpcUrls: [] })).toThrow(/at least one valid RPC URL/i);
      expect(() => new KovanicaClient({ rpcUrls: ["   "] })).toThrow(/non-empty strings/i);
      expect(() => new KovanicaClient({ rpcUrl: "   " })).toThrow(/non-empty string/i);
    });

    it("fails closed on invalid retry config values", () => {
      expect(
        () => new KovanicaClient({ url: "http://127.0.0.1:8545/rpc", retry: { maxRetries: -1 } }),
      ).toThrow(RangeError);
      expect(
        () => new KovanicaClient({ url: "http://127.0.0.1:8545/rpc", retry: { jitterRatio: 1.5 } }),
      ).toThrow(RangeError);
    });
  });

  describe("retry with backoff on transient errors for idempotent methods", () => {
    it("retries kovanica_call on transient HTTP 503 and network errors until success", async () => {
      let calls = 0;
      const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init.body));
        if (calls === 1) {
          throw new TypeError("fetch failed: ECONNRESET");
        }
        if (calls === 2) {
          return makeHttpErrorResponse(503, "Service Unavailable", "overloaded");
        }
        return makeJsonRpcOkResponse(body.id, "0xdeadbeef");
      });

      const client = new KovanicaClient({
        rpcUrl: "http://node-1.local/rpc",
        fetch: mockFetch as unknown as typeof fetch,
        retry: {
          maxRetries: 3,
          initialDelayMs: 5,
          maxDelayMs: 25,
          jitterRatio: 0,
        },
      });

      const result = await client.call<string>("kovanica_call", [
        { contract: "0x" + "11".repeat(32), method: "get", args: "0x" },
      ]);

      expect(result).toBe("0xdeadbeef");
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("retries kovanica_getStorageAt on HTTP 503 and succeeds", async () => {
      let calls = 0;
      const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init.body));
        if (calls === 1) {
          return makeHttpErrorResponse(503, "Service Unavailable");
        }
        return makeJsonRpcOkResponse(body.id, "0x" + "ab".repeat(32));
      });

      const client = new KovanicaClient({
        url: "http://node-1.local/rpc",
        fetch: mockFetch as unknown as typeof fetch,
        retry: { maxRetries: 2, initialDelayMs: 5, jitterRatio: 0 },
      });

      const slotValue = await client.getStorageAt("kvnc123dag", "0x" + "01".repeat(32));
      expect(slotValue).toBe("0x" + "ab".repeat(32));
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("retries kovanica_estimateFee on KovanicaTimeoutError and succeeds", async () => {
      const mockTransport: Transport = {
        send: vi
          .fn()
          .mockRejectedValueOnce(new KovanicaTimeoutError(100))
          .mockResolvedValueOnce("0x64"),
      };

      const client = new KovanicaClient({
        transport: mockTransport,
        retry: { maxRetries: 2, initialDelayMs: 5, jitterRatio: 0 },
      });

      const fee = await client.estimateFee();
      expect(fee).toBe(100n);
      expect(mockTransport.send).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry single-endpoint client when retry is omitted (default maxRetries = 0)", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(makeHttpErrorResponse(503, "Service Unavailable"));

      const client = new KovanicaClient({
        url: "http://node-1.local/rpc",
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(client.estimateFee()).rejects.toThrow(KovanicaTransportError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("non-idempotent kovanica_sendRawTransaction safety", () => {
    it("does NOT retry kovanica_sendRawTransaction by default even with retries & multiple rpcUrls", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(makeHttpErrorResponse(503, "Service Unavailable"));

      const client = new KovanicaClient({
        rpcUrls: ["http://primary.local/rpc", "http://secondary.local/rpc"],
        fetch: mockFetch as unknown as typeof fetch,
        retry: { maxRetries: 3, initialDelayMs: 5, jitterRatio: 0 },
      });

      await expect(client.sendRawTransaction("0x1234")).rejects.toThrow(KovanicaTransportError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("retries kovanica_sendRawTransaction only when explicitly allowlisted in retryableMethods", async () => {
      let calls = 0;
      const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init.body));
        if (calls === 1) {
          return makeHttpErrorResponse(503, "Service Unavailable");
        }
        return makeJsonRpcOkResponse(body.id, "0x" + "ff".repeat(32));
      });

      const client = new KovanicaClient({
        url: "http://primary.local/rpc",
        fetch: mockFetch as unknown as typeof fetch,
        retry: {
          maxRetries: 2,
          initialDelayMs: 5,
          jitterRatio: 0,
          retryableMethods: ["kovanica_sendRawTransaction"],
        },
      });

      const txHash = await client.sendRawTransaction("0x1234");
      expect(txHash).toBe("0x" + "ff".repeat(32));
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("multi-endpoint failover", () => {
    it("automatically fails over from primary to secondary when primary fails", async () => {
      const requestedUrls: string[] = [];
      const mockFetch = vi.fn().mockImplementation(async (url, init) => {
        const urlStr = String(url);
        requestedUrls.push(urlStr);
        const body = JSON.parse(String(init.body));

        if (urlStr === "http://primary.local/rpc") {
          return makeHttpErrorResponse(503, "Service Unavailable");
        }
        return makeJsonRpcOkResponse(body.id, "0x2a");
      });

      const client = new KovanicaClient({
        rpcUrls: ["http://primary.local/rpc", "http://secondary.local/rpc"],
        fetch: mockFetch as unknown as typeof fetch,
      });

      const height1 = await client.blockNumber();
      expect(height1).toBe(42n);
      expect(requestedUrls).toEqual([
        "http://primary.local/rpc",
        "http://secondary.local/rpc",
      ]);

      // Subsequent request sticks to healthy secondary without re-hitting failed primary
      const height2 = await client.blockNumber();
      expect(height2).toBe(42n);
      expect(requestedUrls).toEqual([
        "http://primary.local/rpc",
        "http://secondary.local/rpc",
        "http://secondary.local/rpc",
      ]);
    });

    it("rotates across endpoints with backoff when retry config is combined with rpcUrls", async () => {
      const requestedUrls: string[] = [];
      const mockFetch = vi.fn().mockImplementation(async (url, init) => {
        const urlStr = String(url);
        requestedUrls.push(urlStr);
        const body = JSON.parse(String(init.body));

        if (requestedUrls.length < 3) {
          throw new TypeError("connect ECONNREFUSED");
        }
        return makeJsonRpcOkResponse(body.id, "0x10");
      });

      const client = new KovanicaClient({
        rpcUrl: "http://ep1.local/rpc",
        rpcUrls: ["http://ep2.local/rpc", "http://ep3.local/rpc"],
        fetch: mockFetch as unknown as typeof fetch,
        retry: { maxRetries: 3, initialDelayMs: 5, maxDelayMs: 50, jitterRatio: 0 },
      });

      const fee = await client.estimateFee();
      expect(fee).toBe(16n);
      expect(requestedUrls).toEqual([
        "http://ep1.local/rpc",
        "http://ep2.local/rpc",
        "http://ep3.local/rpc",
      ]);
    });
  });

  describe("AbortSignal cancellation during retry backoff", () => {
    it("cancels immediately when AbortSignal aborts during backoff sleep", async () => {
      const controller = new AbortController();
      const mockFetch = vi.fn().mockImplementation(async () => {
        // Schedule abort shortly after the first transient failure enters backoff sleep
        setTimeout(() => controller.abort(), 15);
        return makeHttpErrorResponse(503, "Service Unavailable");
      });

      const client = new KovanicaClient({
        url: "http://primary.local/rpc",
        fetch: mockFetch as unknown as typeof fetch,
        retry: {
          maxRetries: 3,
          initialDelayMs: 10_000, // Very long backoff; abort must interrupt it immediately
          maxDelayMs: 10_000,
          jitterRatio: 0,
        },
      });

      const start = Date.now();
      await expect(
        client.call("kovanica_call", [], { signal: controller.signal }),
      ).rejects.toThrow(KovanicaAbortError);
      const elapsedMs = Date.now() - start;

      expect(elapsedMs).toBeLessThan(1_000);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("application-level JSON-RPC errors are NOT retried", () => {
    it("does NOT retry revert (-32000) or invalid params (-32602)", async () => {
      const mockFetch = vi
        .fn()
        .mockImplementationOnce(async (_url, init) => {
          const body = JSON.parse(String(init.body));
          return makeJsonRpcErrorResponse(
            body.id,
            RpcErrorCode.ExecutionError,
            "execution reverted: insufficient balance",
          );
        })
        .mockImplementationOnce(async (_url, init) => {
          const body = JSON.parse(String(init.body));
          return makeJsonRpcErrorResponse(
            body.id,
            RpcErrorCode.InvalidParams,
            "invalid slot hex",
          );
        });

      const client = new KovanicaClient({
        rpcUrls: ["http://primary.local/rpc", "http://secondary.local/rpc"],
        fetch: mockFetch as unknown as typeof fetch,
        retry: { maxRetries: 3, initialDelayMs: 5, jitterRatio: 0 },
      });

      await expect(client.call("kovanica_call", [])).rejects.toMatchObject({
        name: "KovanicaRpcError",
        code: RpcErrorCode.ExecutionError,
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await expect(client.getStorageAt("kvnc123dag", "bad-slot")).rejects.toThrow(
        KovanicaRpcError,
      );
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry non-transient HTTP 4xx errors (e.g. 400 Bad Request)", async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeHttpErrorResponse(400, "Bad Request"));

      const client = new KovanicaClient({
        rpcUrls: ["http://primary.local/rpc", "http://secondary.local/rpc"],
        fetch: mockFetch as unknown as typeof fetch,
        retry: { maxRetries: 3, initialDelayMs: 5, jitterRatio: 0 },
      });

      await expect(client.blockNumber()).rejects.toThrow(KovanicaTransportError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
