import { describe, expect, it, vi } from "vitest";
import {
  KovanicaAbortError,
  KovanicaRpcError,
  KovanicaTransportError,
} from "../src/errors";
import {
  FailoverHttpTransport,
  createFailoverHttpTransport,
  sanitizeRpcUrl,
  type FailoverEvent,
} from "../src/transport";

function jsonResponse(payload: unknown, status = 200, statusText = "OK"): Response {
  const body = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => body,
    json: async () => payload,
  } as unknown as Response;
}

function textResponse(body: string, status: number, statusText: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => body,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  } as unknown as Response;
}

describe("sanitizeRpcUrl", () => {
  it("strips embedded credentials, sensitive query tokens, and fragments while preserving safe params", () => {
    expect(
      sanitizeRpcUrl(
        "https://alice:super-secret@rpc.kovanica.io:8545/rpc?api_key=kvnc_live_123&network=testnet&token=tok_xyz#access_token=frag",
      ),
    ).toBe("https://rpc.kovanica.io:8545/rpc?network=testnet");

    expect(
      sanitizeRpcUrl("http://user:pass@127.0.0.1:8545/rpc?password=pw&secret=sec&auth=a"),
    ).toBe("http://127.0.0.1:8545/rpc");

    expect(sanitizeRpcUrl("http://onlyuser@rpc.kovanica.io/rpc")).toBe(
      "http://rpc.kovanica.io/rpc",
    );

    expect(sanitizeRpcUrl("https://rpc.kovanica.io/rpc")).toBe(
      "https://rpc.kovanica.io/rpc",
    );
  });

  it("falls back safely on malformed URLs without leaking credentials", () => {
    const sanitized = sanitizeRpcUrl("not a url https://bob:hunter2@host/rpc?token=abc");
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized).not.toContain("abc");
  });
});

describe("FailoverHttpTransport validation", () => {
  it("rejects empty or invalid URL lists", () => {
    expect(() => new FailoverHttpTransport({ urls: [] })).toThrow(/non-empty/i);
    expect(() => new FailoverHttpTransport({ urls: ["   "] })).toThrow(/non-empty/i);
    expect(() => new FailoverHttpTransport({ urls: ["not-a-valid-url"] })).toThrow(
      /Invalid RPC URL/i,
    );
  });

  it("rejects non-http/https schemes and sanitizes rejected URLs", () => {
    expect(() =>
      new FailoverHttpTransport({ urls: ["ws://user:pass@127.0.0.1:8546/ws"] }),
    ).toThrow(/only http: and https: are supported/i);

    expect(() =>
      new FailoverHttpTransport({ urls: ["wss://rpc.kovanica.io/ws"] }),
    ).toThrow(/only http: and https: are supported/i);

    expect(() =>
      new FailoverHttpTransport({ urls: ["ftp://rpc.kovanica.io/rpc"] }),
    ).toThrow(/only http: and https: are supported/i);

    expect(() =>
      new FailoverHttpTransport({ urls: ["file:///etc/passwd"] }),
    ).toThrow(/only http: and https: are supported/i);

    try {
      new FailoverHttpTransport({ urls: ["ws://alice:secret99@rpc.kovanica.io/ws?token=tok99"] });
      expect.unreachable("Expected constructor to throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain("secret99");
      expect(msg).not.toContain("tok99");
    }
  });
});

describe("FailoverHttpTransport", () => {
  it("succeeds on primary with zero retries and zero sleep calls", async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const failovers: FailoverEvent[] = [];
    let now = 1_000;

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      const req = JSON.parse(String(init?.body)) as { id: number };
      return jsonResponse({ jsonrpc: "2.0", id: req.id, result: "0x2a" });
    }) as unknown as typeof fetch;

    const transport = createFailoverHttpTransport({
      urls: ["https://primary.kovanica.io/rpc", "https://secondary.kovanica.io/rpc"],
      fetch: mockFetch,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onFailover: (event) => failovers.push(event),
    });

    const result = await transport.send<string>("kovanica_blockNumber");
    expect(result).toBe("0x2a");
    expect(calls).toEqual(["https://primary.kovanica.io/rpc"]);
    expect(sleeps).toEqual([]);
    expect(failovers).toEqual([]);

    const health = transport.getEndpointHealth();
    expect(health).toHaveLength(2);
    expect(health[0]).toMatchObject({
      url: "https://primary.kovanica.io/rpc",
      healthy: true,
      state: "closed",
      consecutiveFailures: 0,
      totalFailures: 0,
      totalSuccesses: 1,
      lastSuccessAt: 1_000,
    });
    expect(health[1]).toMatchObject({
      url: "https://secondary.kovanica.io/rpc",
      healthy: true,
      state: "closed",
      totalSuccesses: 0,
    });
  });

  it("fails over from primary HTTP 503 to secondary after bounded retry", async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const failovers: FailoverEvent[] = [];
    let now = 10_000;

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("primary")) {
        return textResponse("upstream overloaded", 503, "Service Unavailable");
      }
      const req = JSON.parse(String(init?.body)) as { id: number };
      return jsonResponse({ jsonrpc: "2.0", id: req.id, result: "0x100" });
    }) as unknown as typeof fetch;

    const transport = new FailoverHttpTransport({
      urls: ["https://primary.kovanica.io/rpc", "https://secondary.kovanica.io/rpc"],
      maxRetriesPerEndpoint: 1,
      baseBackoffMs: 150,
      cooldownMs: 15_000,
      fetch: mockFetch,
      now: () => now,
      randomFn: () => 0.5, // factor = 1.0 -> exact 150ms
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      onFailover: (event) => failovers.push(event),
    });

    const result = await transport.send<string>("kovanica_blockNumber");
    expect(result).toBe("0x100");
    expect(calls).toEqual([
      "https://primary.kovanica.io/rpc",
      "https://primary.kovanica.io/rpc",
      "https://secondary.kovanica.io/rpc",
    ]);
    expect(sleeps).toEqual([150]);
    expect(failovers).toHaveLength(1);
    expect(failovers[0]).toMatchObject({
      fromUrl: "https://primary.kovanica.io/rpc",
      toUrl: "https://secondary.kovanica.io/rpc",
      method: "kovanica_blockNumber",
      attempts: 2,
      status: 503,
    });
  });

  it("fails over on HTTP 429, network error, and timeout", async () => {
    // 1. HTTP 429
    {
      const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("primary")) {
          return textResponse("rate limited", 429, "Too Many Requests");
        }
        const req = JSON.parse(String(init?.body)) as { id: number };
        return jsonResponse({ jsonrpc: "2.0", id: req.id, result: "ok-429" });
      }) as unknown as typeof fetch;

      const transport = new FailoverHttpTransport({
        urls: ["https://primary.kovanica.io/rpc", "https://secondary.kovanica.io/rpc"],
        maxRetriesPerEndpoint: 0,
        fetch: mockFetch,
      });

      expect(await transport.send("kovanica_chainId")).toBe("ok-429");
    }

    // 2. Network error
    {
      const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("primary")) {
          throw new TypeError("fetch failed: ECONNREFUSED");
        }
        const req = JSON.parse(String(init?.body)) as { id: number };
        return jsonResponse({ jsonrpc: "2.0", id: req.id, result: "ok-net" });
      }) as unknown as typeof fetch;

      const transport = new FailoverHttpTransport({
        urls: ["https://primary.kovanica.io/rpc", "https://secondary.kovanica.io/rpc"],
        maxRetriesPerEndpoint: 0,
        fetch: mockFetch,
      });

      expect(await transport.send("kovanica_chainId")).toBe("ok-net");
    }

    // 3. Timeout on primary -> secondary succeeds
    {
      const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("primary")) {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("Aborted");
              err.name = "AbortError";
              reject(err);
            });
          });
        }
        const req = JSON.parse(String(init?.body)) as { id: number };
        return jsonResponse({ jsonrpc: "2.0", id: req.id, result: "ok-timeout" });
      }) as unknown as typeof fetch;

      const transport = new FailoverHttpTransport({
        urls: ["https://primary.kovanica.io/rpc", "https://secondary.kovanica.io/rpc"],
        timeoutMs: 25,
        maxRetriesPerEndpoint: 0,
        fetch: mockFetch,
      });

      expect(await transport.send("kovanica_chainId")).toBe("ok-timeout");
    }
  });

  it("skips primary during circuit-breaker cooldown and probes again once cooldown elapses", async () => {
    const calls: string[] = [];
    let now = 50_000;
    let primaryHealthy = false;

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("primary") && !primaryHealthy) {
        return textResponse("down", 503, "Service Unavailable");
      }
      const req = JSON.parse(String(init?.body)) as { id: number };
      return jsonResponse({
        jsonrpc: "2.0",
        id: req.id,
        result: url.includes("primary") ? "from-primary" : "from-secondary",
      });
    }) as unknown as typeof fetch;

    const transport = new FailoverHttpTransport({
      urls: ["https://primary.kovanica.io/rpc", "https://secondary.kovanica.io/rpc"],
      maxRetriesPerEndpoint: 0,
      cooldownMs: 15_000,
      fetch: mockFetch,
      now: () => now,
    });

    // Request 1: primary fails, circuit opens until 65_000, secondary succeeds
    expect(await transport.send("kovanica_blockNumber")).toBe("from-secondary");
    expect(calls).toEqual([
      "https://primary.kovanica.io/rpc",
      "https://secondary.kovanica.io/rpc",
    ]);

    const openHealth = transport.getEndpointHealth();
    expect(openHealth[0]).toMatchObject({
      healthy: false,
      state: "open",
      consecutiveFailures: 1,
      cooldownUntil: 65_000,
    });

    // Request 2 at t = 60_000 (still inside cooldown): primary MUST be skipped
    now = 60_000;
    calls.length = 0;
    expect(await transport.send("kovanica_blockNumber")).toBe("from-secondary");
    expect(calls).toEqual(["https://secondary.kovanica.io/rpc"]);

    // Advance past cooldown (t = 65_000): primary becomes half-open and is probed
    now = 65_000;
    expect(transport.getEndpointHealth()[0]).toMatchObject({
      healthy: true,
      state: "half-open",
      cooldownUntil: undefined,
    });

    primaryHealthy = true;
    calls.length = 0;
    expect(await transport.send("kovanica_blockNumber")).toBe("from-primary");
    expect(calls).toEqual(["https://primary.kovanica.io/rpc"]);

    // After successful probe, primary circuit closes cleanly
    expect(transport.getEndpointHealth()[0]).toMatchObject({
      healthy: true,
      state: "closed",
      consecutiveFailures: 0,
      totalFailures: 1,
      totalSuccesses: 1,
      lastSuccessAt: 65_000,
      lastError: undefined,
    });
  });

  it("does NOT retry deterministic JSON-RPC application errors (HTTP 200) on primary or secondary", async () => {
    const calls: string[] = [];
    const failovers: FailoverEvent[] = [];

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      const req = JSON.parse(String(init?.body)) as { id: number };
      return jsonResponse({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32602, message: "Invalid params" },
      });
    }) as unknown as typeof fetch;

    const transport = new FailoverHttpTransport({
      urls: ["https://primary.kovanica.io/rpc", "https://secondary.kovanica.io/rpc"],
      maxRetriesPerEndpoint: 2,
      fetch: mockFetch,
      onFailover: (event) => failovers.push(event),
    });

    await expect(transport.send("kovanica_getBalance", ["bad"])).rejects.toThrow(
      KovanicaRpcError,
    );
    expect(calls).toEqual(["https://primary.kovanica.io/rpc"]);
    expect(failovers).toEqual([]);
    expect(transport.getEndpointHealth()[0]).toMatchObject({
      healthy: true,
      state: "closed",
      totalFailures: 0,
      totalSuccesses: 1,
    });
  });

  it("does NOT retry non-retryable HTTP 4xx errors (e.g. 401/400)", async () => {
    const calls: string[] = [];

    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return textResponse("Unauthorized", 401, "Unauthorized");
    }) as unknown as typeof fetch;

    const transport = new FailoverHttpTransport({
      urls: ["https://primary.kovanica.io/rpc", "https://secondary.kovanica.io/rpc"],
      maxRetriesPerEndpoint: 2,
      fetch: mockFetch,
    });

    await expect(transport.send("kovanica_blockNumber")).rejects.toThrow(
      KovanicaTransportError,
    );
    expect(calls).toEqual(["https://primary.kovanica.io/rpc"]);
  });

  it("supports sendBatch failover on transient errors without retrying HTTP 200 batch item errors", async () => {
    const calls: string[] = [];

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("primary")) {
        return textResponse("bad gateway", 502, "Bad Gateway");
      }
      const reqs = JSON.parse(String(init?.body)) as Array<{ id: number; method: string }>;
      return jsonResponse([
        { jsonrpc: "2.0", id: reqs[0]!.id, result: "0x1" },
        {
          jsonrpc: "2.0",
          id: reqs[1]!.id,
          error: { code: -32601, message: "Method not found" },
        },
      ]);
    }) as unknown as typeof fetch;

    const transport = new FailoverHttpTransport({
      urls: ["https://primary.kovanica.io/rpc", "https://secondary.kovanica.io/rpc"],
      maxRetriesPerEndpoint: 0,
      fetch: mockFetch,
    });

    const results = await transport.sendBatch([
      { method: "kovanica_chainId" },
      { method: "kovanica_unknownMethod" },
    ]);

    expect(calls).toEqual([
      "https://primary.kovanica.io/rpc",
      "https://secondary.kovanica.io/rpc",
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ ok: true, result: "0x1" });
    expect(results[1]!.ok).toBe(false);
    if (!results[1]!.ok) {
      expect(results[1]!.error).toBeInstanceOf(KovanicaRpcError);
      expect(results[1]!.error.code).toBe(-32601);
    }
  });

  it("never leaks credentials in urls, health snapshots, failover events, or thrown errors", async () => {
    const primaryRaw =
      "https://alice:top-secret-pw@primary.kovanica.io/rpc?api_key=secret_key_1&env=prod";
    const secondaryRaw =
      "https://bob:another-secret@secondary.kovanica.io/rpc?token=secret_tok_2";
    const failovers: FailoverEvent[] = [];

    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      throw new Error(`connect ECONNREFUSED ${url}`);
    }) as unknown as typeof fetch;

    const transport = new FailoverHttpTransport({
      urls: [primaryRaw, secondaryRaw],
      maxRetriesPerEndpoint: 0,
      fetch: mockFetch,
      onFailover: (event) => failovers.push(event),
    });

    // Exposed urls are sanitized
    expect(transport.urls).toEqual([
      "https://primary.kovanica.io/rpc?env=prod",
      "https://secondary.kovanica.io/rpc",
    ]);

    let caughtError: unknown;
    try {
      await transport.send("kovanica_blockNumber");
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(KovanicaTransportError);
    const errMsg = (caughtError as Error).message;

    const serializedAll = JSON.stringify({
      urls: transport.urls,
      health: transport.getEndpointHealth(),
      failovers,
      errMsg,
    });

    for (const secret of [
      "alice",
      "top-secret-pw",
      "secret_key_1",
      "bob",
      "another-secret",
      "secret_tok_2",
    ]) {
      expect(serializedAll).not.toContain(secret);
    }

    expect(failovers).toHaveLength(2);
    expect(failovers[0]!.fromUrl).toBe("https://primary.kovanica.io/rpc?env=prod");
    expect(failovers[0]!.toUrl).toBe("https://secondary.kovanica.io/rpc");
    expect(failovers[1]!.fromUrl).toBe("https://secondary.kovanica.io/rpc");
    expect(failovers[1]!.toUrl).toBeUndefined();
  });

  it("respects AbortSignal immediately without retrying or failing over", async () => {
    const controller = new AbortController();
    controller.abort();

    const mockFetch = vi.fn() as unknown as typeof fetch;
    const transport = new FailoverHttpTransport({
      urls: ["https://primary.kovanica.io/rpc", "https://secondary.kovanica.io/rpc"],
      fetch: mockFetch,
    });

    await expect(
      transport.send("kovanica_blockNumber", undefined, { signal: controller.signal }),
    ).rejects.toThrow(KovanicaAbortError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
