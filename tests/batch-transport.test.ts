import { describe, expect, it, vi } from "vitest";
import {
  KovanicaAbortError,
  KovanicaClient,
  KovanicaRpcError,
  KovanicaTimeoutError,
  KovanicaTransportError,
  MAX_JSONRPC_BATCH_SIZE,
  RpcErrorCode,
  type JsonRpcBatchRequestItem,
  type Transport,
} from "../src/index";

function makeBatchJsonResponse(body: unknown) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
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

describe("JSON-RPC 2.0 Batch Transport (client.callBatch)", () => {
  it("executes a batch in a single HTTP POST and correlates out-of-order response IDs", async () => {
    const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
      expect(init.method).toBe("POST");
      const sent = JSON.parse(String(init.body));
      expect(Array.isArray(sent)).toBe(true);
      expect(sent).toHaveLength(3);
      expect(sent[0]).toMatchObject({ jsonrpc: "2.0", method: "kovanica_blockNumber" });
      expect(sent[1]).toMatchObject({
        jsonrpc: "2.0",
        method: "kovanica_getBalance",
        params: ["kvnc1alice"],
      });
      expect(sent[2]).toMatchObject({ jsonrpc: "2.0", method: "kovanica_estimateFee", params: [] });

      // Respond in reverse/out-of-order ID sequence, including an unquoted u64::MAX integer
      const rawJson = `[
        {"jsonrpc":"2.0","id":${sent[2].id},"result":"0x64"},
        {"jsonrpc":"2.0","id":${sent[0].id},"result":18446744073709551615},
        {"jsonrpc":"2.0","id":${sent[1].id},"result":"0x2540be400"}
      ]`;
      return makeBatchJsonResponse(rawJson);
    });

    const client = new KovanicaClient({
      url: "http://127.0.0.1:8545/rpc",
      fetch: mockFetch as unknown as typeof fetch,
    });

    const results = await client.callBatch([
      { method: "kovanica_blockNumber" },
      { method: "kovanica_getBalance", params: ["kvnc1alice"] },
      { method: "kovanica_estimateFee", params: [] },
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      { ok: true, result: "18446744073709551615" },
      { ok: true, result: "0x2540be400" },
      { ok: true, result: "0x64" },
    ]);
  });

  it("isolates per-item JSON-RPC errors without failing successful items in the same batch", async () => {
    const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
      const sent = JSON.parse(String(init.body));
      return makeBatchJsonResponse([
        { jsonrpc: "2.0", id: sent[1].id, error: { code: RpcErrorCode.InvalidParams, message: "bad address", data: { index: 1 } } },
        { jsonrpc: "2.0", id: sent[0].id, result: "0x2a" },
        { jsonrpc: "2.0", id: sent[2].id, error: { code: RpcErrorCode.ExecutionError, message: "reverted" } },
      ]);
    });

    const client = new KovanicaClient({
      url: "http://127.0.0.1:8545/rpc",
      fetch: mockFetch as unknown as typeof fetch,
    });

    const results = await client.callBatch([
      { method: "kovanica_blockNumber", params: [] },
      { method: "kovanica_getBalance", params: ["invalid"] },
      { method: "kovanica_call", params: [{ contract: "0x11", method: "foo", args: "0x" }] },
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual({ ok: true, result: "0x2a" });

    expect(results[1].ok).toBe(false);
    if (!results[1].ok) {
      expect(results[1].error).toBeInstanceOf(KovanicaRpcError);
      expect(results[1].error.code).toBe(RpcErrorCode.InvalidParams);
      expect(results[1].error.message).toContain("bad address");
      expect(results[1].error.data).toEqual({ index: 1 });
    }

    expect(results[2].ok).toBe(false);
    if (!results[2].ok) {
      expect(results[2].error).toBeInstanceOf(KovanicaRpcError);
      expect(results[2].error.code).toBe(RpcErrorCode.ExecutionError);
      expect(results[2].error.message).toContain("reverted");
    }
  });

  it("rejects empty and oversized (>32) batches fail-closed before any network I/O", async () => {
    expect(MAX_JSONRPC_BATCH_SIZE).toBe(32);

    const mockFetch = vi.fn();
    const client = new KovanicaClient({
      url: "http://127.0.0.1:8545/rpc",
      fetch: mockFetch as unknown as typeof fetch,
    });

    await expect(client.callBatch([])).rejects.toThrow(RangeError);
    expect(mockFetch).not.toHaveBeenCalled();

    const oversized: JsonRpcBatchRequestItem[] = Array.from(
      { length: MAX_JSONRPC_BATCH_SIZE + 1 },
      () => ({ method: "kovanica_blockNumber", params: [] }),
    );
    await expect(client.callBatch(oversized)).rejects.toThrow(RangeError);
    expect(mockFetch).not.toHaveBeenCalled();

    await expect(client.callBatch([{ method: "   " }])).rejects.toThrow(TypeError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("allows exactly MAX_JSONRPC_BATCH_SIZE (32) requests in one batch", async () => {
    const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
      const sent = JSON.parse(String(init.body));
      expect(sent).toHaveLength(MAX_JSONRPC_BATCH_SIZE);
      return makeBatchJsonResponse(
        sent.map((item: { id: number }) => ({
          jsonrpc: "2.0",
          id: item.id,
          result: `0x${item.id.toString(16)}`,
        })),
      );
    });

    const client = new KovanicaClient({
      url: "http://127.0.0.1:8545/rpc",
      fetch: mockFetch as unknown as typeof fetch,
    });

    const maxBatch: JsonRpcBatchRequestItem[] = Array.from(
      { length: MAX_JSONRPC_BATCH_SIZE },
      () => ({ method: "kovanica_blockNumber", params: [] }),
    );
    const results = await client.callBatch<string>(maxBatch);
    expect(results).toHaveLength(MAX_JSONRPC_BATCH_SIZE);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed, non-array, missing-id, and duplicate-id batch responses fail-closed", async () => {
    const nonArrayFetch = vi.fn().mockResolvedValue(
      makeBatchJsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" }),
    );
    const client1 = new KovanicaClient({
      url: "http://127.0.0.1:8545/rpc",
      fetch: nonArrayFetch as unknown as typeof fetch,
    });
    await expect(
      client1.callBatch([{ method: "kovanica_blockNumber" }]),
    ).rejects.toThrow(/payload must be a JSON array/);

    const missingIdFetch = vi.fn().mockImplementation(async (_url, init) => {
      const sent = JSON.parse(String(init.body));
      // Only return response for first item, omit second
      return makeBatchJsonResponse([{ jsonrpc: "2.0", id: sent[0].id, result: "0x1" }]);
    });
    const client2 = new KovanicaClient({
      url: "http://127.0.0.1:8545/rpc",
      fetch: missingIdFetch as unknown as typeof fetch,
    });
    await expect(
      client2.callBatch([
        { method: "kovanica_blockNumber" },
        { method: "kovanica_estimateFee" },
      ]),
    ).rejects.toThrow(/missing response for request id/);

    const dupIdFetch = vi.fn().mockImplementation(async (_url, init) => {
      const sent = JSON.parse(String(init.body));
      return makeBatchJsonResponse([
        { jsonrpc: "2.0", id: sent[0].id, result: "0x1" },
        { jsonrpc: "2.0", id: sent[0].id, result: "0x2" },
      ]);
    });
    const client3 = new KovanicaClient({
      url: "http://127.0.0.1:8545/rpc",
      fetch: dupIdFetch as unknown as typeof fetch,
    });
    await expect(
      client3.callBatch([
        { method: "kovanica_blockNumber" },
        { method: "kovanica_estimateFee" },
      ]),
    ).rejects.toThrow(/duplicate response id/);
  });

  it("redacts credentials in batch transport errors", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        makeHttpErrorResponse(502, "Bad Gateway", "Upstream error Bearer super-secret-token-xyz"),
      );

    const client = new KovanicaClient({
      url: "http://user:my-secret-pw@127.0.0.1:8545/rpc",
      fetch: mockFetch as unknown as typeof fetch,
    });

    let caught: unknown;
    try {
      await client.callBatch([{ method: "kovanica_blockNumber" }]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(KovanicaTransportError);
    const err = caught as KovanicaTransportError;
    expect(err.status).toBe(502);
    expect(err.message).not.toContain("super-secret-token-xyz");
    expect(err.message).toContain("Bearer ***");
  });

  it("fails over and retries all-idempotent batches across fallback rpcUrls", async () => {
    const requestedUrls: string[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url, init) => {
      const urlStr = String(url);
      requestedUrls.push(urlStr);
      const sent = JSON.parse(String(init.body));
      if (urlStr === "http://primary.local/rpc") {
        return makeHttpErrorResponse(503, "Service Unavailable");
      }
      return makeBatchJsonResponse(
        sent.map((item: { id: number }, idx: number) => ({
          jsonrpc: "2.0",
          id: item.id,
          result: idx === 0 ? "0x10" : "0x20",
        })),
      );
    });

    const client = new KovanicaClient({
      rpcUrls: ["http://primary.local/rpc", "http://secondary.local/rpc"],
      fetch: mockFetch as unknown as typeof fetch,
      retry: { maxRetries: 2, initialDelayMs: 5, jitterRatio: 0 },
    });

    const results = await client.callBatch<string>([
      { method: "kovanica_blockNumber", params: [] },
      { method: "kovanica_estimateFee", params: [] },
    ]);

    expect(results).toEqual([
      { ok: true, result: "0x10" },
      { ok: true, result: "0x20" },
    ]);
    expect(requestedUrls).toEqual([
      "http://primary.local/rpc",
      "http://secondary.local/rpc",
    ]);
  });

  it("does NOT retry a batch containing kovanica_sendRawTransaction even with retries & multiple rpcUrls", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeHttpErrorResponse(503, "Service Unavailable"));

    const client = new KovanicaClient({
      rpcUrls: ["http://primary.local/rpc", "http://secondary.local/rpc"],
      fetch: mockFetch as unknown as typeof fetch,
      retry: { maxRetries: 3, initialDelayMs: 5, jitterRatio: 0 },
    });

    await expect(
      client.callBatch([
        { method: "kovanica_blockNumber", params: [] },
        { method: "kovanica_sendRawTransaction", params: ["0xdeadbeef"] },
      ]),
    ).rejects.toThrow(KovanicaTransportError);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects immediately when AbortSignal is pre-aborted without performing network I/O", async () => {
    const mockFetch = vi.fn();
    const client = new KovanicaClient({
      url: "http://127.0.0.1:8545/rpc",
      fetch: mockFetch as unknown as typeof fetch,
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      client.callBatch([{ method: "kovanica_blockNumber" }], { signal: controller.signal }),
    ).rejects.toThrow(KovanicaAbortError);

    await expect(
      client.callBatch([{ method: "kovanica_blockNumber" }], { signal: controller.signal }),
    ).rejects.toThrow("Request was already aborted");

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("falls back to parallel transport.send for custom transports without sendBatch", async () => {
    const mockTransport: Transport = {
      send: vi.fn().mockImplementation(async (method: string) => {
        if (method === "kovanica_blockNumber") return "0x7";
        if (method === "kovanica_getBalance") {
          throw new KovanicaRpcError(RpcErrorCode.InvalidParams, "bad addr");
        }
        throw new KovanicaTimeoutError(50);
      }),
    };

    const client = new KovanicaClient({ transport: mockTransport });

    const results = await client.callBatch<string>([
      { method: "kovanica_blockNumber", params: [] },
      { method: "kovanica_getBalance", params: ["bad"] },
    ]);

    expect(mockTransport.send).toHaveBeenCalledTimes(2);
    expect(results[0]).toEqual({ ok: true, result: "0x7" });
    expect(results[1].ok).toBe(false);
    if (!results[1].ok) {
      expect(results[1].error).toBeInstanceOf(KovanicaRpcError);
      expect(results[1].error.code).toBe(RpcErrorCode.InvalidParams);
    }
  });
});
