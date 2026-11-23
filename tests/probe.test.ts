import { describe, expect, it, vi } from "vitest";
import { NETWORK_TAGS } from "../src/chains";
import { probeRpcNode } from "../src/probe";

function makeJsonResponse(
  body: unknown,
  init?: { status?: number; statusText?: string; headers?: Record<string, string> },
): Response {
  const status = init?.status ?? 200;
  const statusText = init?.statusText ?? (status === 200 ? "OK" : "Error");
  const headers = new Headers({
    "Content-Type": "application/json",
    ...init?.headers,
  });
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(payload, { status, statusText, headers });
}

describe("probeRpcNode", () => {
  it("succeeds on a healthy single-POST batch with out-of-order response IDs and valid Chain 2 headers", async () => {
    let tick = 1_000;
    const now = () => {
      const current = tick;
      tick += 42;
      return current;
    };

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://rpc.testnet.kovanica.org/rpc");
      expect(init?.method).toBe("POST");

      const sent = JSON.parse(String(init?.body)) as Array<{
        jsonrpc: string;
        id: number;
        method: string;
        params: unknown[];
      }>;
      expect(sent).toHaveLength(3);
      expect(sent.map((item) => item.method)).toEqual([
        "kovanica_chainId",
        "kovanica_blockNumber",
        "kovanica_estimateFee",
      ]);

      // Return out-of-order IDs (3, 1, 2)
      return makeJsonResponse(
        [
          { jsonrpc: "2.0", id: 3, result: "0x3e8" }, // 1000n feeRate
          { jsonrpc: "2.0", id: 1, result: "0x2" }, // 2n chainId
          { jsonrpc: "2.0", id: 2, result: "0x1a4" }, // 420n blockHeight
        ],
        {
          headers: {
            "X-Kovanica-Network-Tag": NETWORK_TAGS.TESTNET,
            "X-Kovanica-Rpc-Version": "0.9.4",
            "X-Kovanica-Chain-Id": "2",
          },
        },
      );
    });

    const result = await probeRpcNode("https://rpc.testnet.kovanica.org/rpc", {
      fetch: mockFetch as unknown as typeof fetch,
      expectedChainId: 2,
      now,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      url: "https://rpc.testnet.kovanica.org/rpc",
      chainId: 2n,
      blockHeight: 420n,
      feeRate: 1000n,
      batchSupported: true,
      networkTag: NETWORK_TAGS.TESTNET,
      rpcVersion: "0.9.4",
      headerChainId: 2n,
      canonicalTagMatch: true,
      latencyMs: 42,
    });
  });

  it("fails cleanly with canonicalTagMatch: false when X-Kovanica-Network-Tag mismatches Chain 1 or 2", async () => {
    const mockFetch = vi.fn(async () =>
      makeJsonResponse(
        [
          { jsonrpc: "2.0", id: 1, result: "0x1" },
          { jsonrpc: "2.0", id: 2, result: "0x64" },
          { jsonrpc: "2.0", id: 3, result: "0x10" },
        ],
        {
          headers: {
            "X-Kovanica-Network-Tag": "1-deadbeefcafebabe",
            "X-Kovanica-Rpc-Version": "1.0.0",
            "X-Kovanica-Chain-Id": "1",
          },
        },
      ),
    );

    const result = await probeRpcNode("https://rpc.kovanica.org/rpc", {
      fetch: mockFetch as unknown as typeof fetch,
      now: () => 500,
    });

    expect(result.ok).toBe(false);
    expect(result.batchSupported).toBe(true);
    expect(result.chainId).toBe(1n);
    expect(result.blockHeight).toBe(100n);
    expect(result.feeRate).toBe(16n);
    expect(result.networkTag).toBe("1-deadbeefcafebabe");
    expect(result.canonicalTagMatch).toBe(false);
    expect(result.error).toContain("Canonical network tag mismatch");
    expect(result.error).toContain(NETWORK_TAGS.MAINNET);
  });

  it("returns canonicalTagMatch: null for unknown chains or absent network-tag header", async () => {
    const mockFetch = vi.fn(async () =>
      makeJsonResponse([
        { jsonrpc: "2.0", id: 1, result: "0x3" },
        { jsonrpc: "2.0", id: 2, result: "0x1" },
        { jsonrpc: "2.0", id: 3, result: "0x5" },
      ]),
    );

    const result = await probeRpcNode("http://127.0.0.1:8545/rpc", {
      fetch: mockFetch as unknown as typeof fetch,
      expectedChainId: 3n,
      now: () => 100,
    });

    expect(result.ok).toBe(true);
    expect(result.chainId).toBe(3n);
    expect(result.canonicalTagMatch).toBeNull();
    expect(result.networkTag).toBeUndefined();
  });

  it("fails cleanly when expectedChainId does not match the node chainId", async () => {
    const mockFetch = vi.fn(async () =>
      makeJsonResponse(
        [
          { jsonrpc: "2.0", id: 1, result: "0x2" },
          { jsonrpc: "2.0", id: 2, result: "0x50" },
          { jsonrpc: "2.0", id: 3, result: "0x14" },
        ],
        {
          headers: {
            "X-Kovanica-Network-Tag": NETWORK_TAGS.TESTNET,
          },
        },
      ),
    );

    const result = await probeRpcNode("https://rpc.testnet.kovanica.org/rpc", {
      fetch: mockFetch as unknown as typeof fetch,
      expectedChainId: 1n,
      now: () => 200,
    });

    expect(result.ok).toBe(false);
    expect(result.chainId).toBe(2n);
    expect(result.batchSupported).toBe(true);
    expect(result.canonicalTagMatch).toBe(true);
    expect(result.error).toContain("Expected chainId 1, got 2");
  });

  it("marks batchSupported: false cleanly on legacy non-array JSON responses", async () => {
    const mockFetch = vi.fn(async () =>
      makeJsonResponse(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Batch requests are not supported" },
        },
        {
          headers: {
            "X-Kovanica-Rpc-Version": "0.5.0-legacy",
          },
        },
      ),
    );

    const result = await probeRpcNode("http://127.0.0.1:8545/rpc", {
      fetch: mockFetch as unknown as typeof fetch,
      now: () => 300,
    });

    expect(result.ok).toBe(false);
    expect(result.batchSupported).toBe(false);
    expect(result.rpcVersion).toBe("0.5.0-legacy");
    expect(result.canonicalTagMatch).toBeNull();
    expect(result.error).toContain("batch");
    expect(result.error).toContain("Batch requests are not supported");
  });

  it("handles HTTP 503 and sanitizes credentials in url and error", async () => {
    const secretUrl = "https://alice:super-secret-pass@rpc.kovanica.org/rpc?api_key=sk_live_99999&mode=ro";
    const mockFetch = vi.fn(async () =>
      makeJsonResponse(
        `Upstream failed for ${secretUrl} with Bearer eyJhbGciOiJIUzI1NiJ9.secret`,
        {
          status: 503,
          statusText: "Service Unavailable",
          headers: {
            "X-Kovanica-Rpc-Version": "0.9.4",
          },
        },
      ),
    );

    const result = await probeRpcNode(secretUrl, {
      fetch: mockFetch as unknown as typeof fetch,
      now: () => 400,
    });

    expect(result.ok).toBe(false);
    expect(result.batchSupported).toBe(false);
    expect(result.rpcVersion).toBe("0.9.4");
    expect(result.url).toBe("https://rpc.kovanica.org/rpc?mode=ro");
    expect(result.url).not.toContain("super-secret-pass");
    expect(result.url).not.toContain("sk_live_99999");
    expect(result.error).toContain("HTTP 503 Service Unavailable");
    expect(result.error).not.toContain("super-secret-pass");
    expect(result.error).not.toContain("sk_live_99999");
    expect(result.error).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("handles network errors with credential sanitization", async () => {
    const secretUrl = "https://bob:topsecret@node.kovanica.org:8545/rpc?token=tok_abc123";
    const mockFetch = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED ${secretUrl}`);
    });

    const result = await probeRpcNode(secretUrl, {
      fetch: mockFetch as unknown as typeof fetch,
      now: () => 600,
    });

    expect(result.ok).toBe(false);
    expect(result.batchSupported).toBe(false);
    expect(result.canonicalTagMatch).toBeNull();
    expect(result.url).toBe("https://node.kovanica.org:8545/rpc");
    expect(result.error).toContain("ECONNREFUSED");
    expect(result.error).not.toContain("topsecret");
    expect(result.error).not.toContain("tok_abc123");
  });

  it("rejects invalid URL schemes without invoking fetch and without leaking credentials", async () => {
    const mockFetch = vi.fn();
    const badUrl = "ws://user:hunter2@rpc.kovanica.org/ws?token=secret_ws_tok";

    const result = await probeRpcNode(badUrl, {
      fetch: mockFetch as unknown as typeof fetch,
      now: () => 700,
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.batchSupported).toBe(false);
    expect(result.canonicalTagMatch).toBeNull();
    expect(result.url).toBe("ws://rpc.kovanica.org/ws");
    expect(result.error).toContain('Invalid RPC URL scheme "ws:"');
    expect(result.error).not.toContain("hunter2");
    expect(result.error).not.toContain("secret_ws_tok");
  });
});
