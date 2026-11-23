import { describe, expect, it, vi } from "vitest";
import { KovanicaClient } from "../src/client";
import {
  computeFeeRecommendations,
  parseMempoolFeeStats,
  type MempoolFeeStats,
} from "../src/mempool-stats";
import type { Transport } from "../src/transport";

describe("parseMempoolFeeStats", () => {
  it("parses snake_case L1 kovanica_mempoolStats payloads with hex and numeric quantities", () => {
    const parsed = parseMempoolFeeStats({
      pending_count: 14,
      total_bytes: "0x1000",
      min_fee_per_byte: "0xa",
      p50_fee_per_byte: "0x14",
      p90_fee_per_byte: "0x32",
      max_fee_per_byte: "0x64",
    });

    expect(parsed).toEqual({
      pendingCount: 14,
      totalBytes: 4096,
      minFeePerByte: 10n,
      p50FeePerByte: 20n,
      p90FeePerByte: 50n,
      maxFeePerByte: 100n,
    });
  });

  it("parses camelCase payloads including large bigint/hex fee values and explicit zero", () => {
    const parsed = parseMempoolFeeStats({
      pendingCount: 3,
      totalBytes: 1024,
      minFeePerByte: "0x0",
      p50FeePerByte: "10000000000000000001",
      p90FeePerByte: 20_000_000_000_000_000_000n,
      maxFeePerByte: "0x1bc16d674ec80000",
    });

    expect(parsed).toEqual({
      pendingCount: 3,
      totalBytes: 1024,
      minFeePerByte: 0n,
      p50FeePerByte: 10_000_000_000_000_000_001n,
      p90FeePerByte: 20_000_000_000_000_000_000n,
      maxFeePerByte: 2_000_000_000_000_000_000n,
    });
  });

  it("parses empty mempool payloads with null fee percentiles", () => {
    const parsed = parseMempoolFeeStats({
      pending_count: 0,
      total_bytes: 0,
      min_fee_per_byte: null,
      p50_fee_per_byte: null,
      p90_fee_per_byte: null,
      max_fee_per_byte: null,
    });

    expect(parsed).toEqual({
      pendingCount: 0,
      totalBytes: 0,
      minFeePerByte: null,
      p50FeePerByte: null,
      p90FeePerByte: null,
      maxFeePerByte: null,
    });
  });

  it("rejects malformed or negative payloads", () => {
    expect(() => parseMempoolFeeStats(null)).toThrow(TypeError);
    expect(() => parseMempoolFeeStats([])).toThrow(TypeError);
    expect(() => parseMempoolFeeStats("invalid")).toThrow(TypeError);
    expect(() => parseMempoolFeeStats({ total_bytes: 0 })).toThrow(TypeError);
    expect(() =>
      parseMempoolFeeStats({
        pending_count: -1,
        total_bytes: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      parseMempoolFeeStats({
        pending_count: 1,
        total_bytes: 100,
        p50_fee_per_byte: -5n,
      }),
    ).toThrow(RangeError);
  });
});

describe("computeFeeRecommendations", () => {
  it("computes buffered economy, standard, and priority tiers from populated mempool stats", () => {
    const stats: MempoolFeeStats = {
      pendingCount: 25,
      totalBytes: 8192,
      minFeePerByte: 10n,
      p50FeePerByte: 20n,
      p90FeePerByte: 50n,
      maxFeePerByte: 100n,
    };

    const rec = computeFeeRecommendations(stats);
    expect(rec).toEqual({
      economy: 10n,
      standard: 24n, // 20 * 1.2
      priority: 60n, // 50 * 1.2
      source: "mempool",
    });
    expect(rec.economy <= rec.standard).toBe(true);
    expect(rec.standard <= rec.priority).toBe(true);
  });

  it("falls back cleanly to default 1n or custom fallbackBaseFeePerByte when mempool is empty", () => {
    const emptyStats: MempoolFeeStats = {
      pendingCount: 0,
      totalBytes: 0,
      minFeePerByte: null,
      p50FeePerByte: null,
      p90FeePerByte: null,
      maxFeePerByte: null,
    };

    const defaultFallback = computeFeeRecommendations(emptyStats);
    expect(defaultFallback.source).toBe("fallback");
    expect(defaultFallback.economy).toBe(1n);
    expect(defaultFallback.standard).toBe(2n); // ceil(1 * 1.2)
    expect(defaultFallback.priority).toBe(3n); // ceil(2 * 1.2)
    expect(defaultFallback.economy <= defaultFallback.standard).toBe(true);
    expect(defaultFallback.standard <= defaultFallback.priority).toBe(true);

    const customFallback = computeFeeRecommendations(emptyStats, {
      fallbackBaseFeePerByte: 100n,
      safetyMultiplierBps: 12_500, // 1.25x
    });
    expect(customFallback).toEqual({
      economy: 100n,
      standard: 125n,
      priority: 157n, // ceil(125 * 1.25) = 157
      source: "fallback",
    });
  });

  it("guarantees monotonic economy <= standard <= priority even with inverted or partial percentiles", () => {
    const invertedStats: MempoolFeeStats = {
      pendingCount: 5,
      totalBytes: 500,
      minFeePerByte: 100n,
      p50FeePerByte: 20n,
      p90FeePerByte: 10n,
      maxFeePerByte: 100n,
    };

    const rec = computeFeeRecommendations(invertedStats);
    expect(rec).toEqual({
      economy: 100n,
      standard: 100n,
      priority: 100n,
      source: "mempool",
    });
    expect(rec.economy <= rec.standard).toBe(true);
    expect(rec.standard <= rec.priority).toBe(true);

    const missingMinAndP90: MempoolFeeStats = {
      pendingCount: 2,
      totalBytes: 256,
      minFeePerByte: null,
      p50FeePerByte: 10n,
      p90FeePerByte: null,
      maxFeePerByte: 30n,
    };

    const recPartial = computeFeeRecommendations(missingMinAndP90, {
      fallbackBaseFeePerByte: 5n,
    });
    expect(recPartial).toEqual({
      economy: 5n,
      standard: 12n, // 10 * 1.2
      priority: 36n, // maxFeePerByte (30) * 1.2
      source: "mempool",
    });
  });

  it("validates fallbackBaseFeePerByte and safetyMultiplierBps", () => {
    const emptyStats: MempoolFeeStats = {
      pendingCount: 0,
      totalBytes: 0,
      minFeePerByte: null,
      p50FeePerByte: null,
      p90FeePerByte: null,
      maxFeePerByte: null,
    };

    expect(() =>
      computeFeeRecommendations(emptyStats, { fallbackBaseFeePerByte: -1n }),
    ).toThrow(RangeError);
    expect(() =>
      computeFeeRecommendations(emptyStats, { safetyMultiplierBps: 9_999 }),
    ).toThrow(RangeError);
  });
});

describe("KovanicaClient.getMempoolStats", () => {
  it("calls kovanica_mempoolStats and returns parsed MempoolFeeStats", async () => {
    const mockTransport: Transport = {
      send: vi.fn().mockResolvedValue({
        pending_count: 7,
        total_bytes: 2048,
        min_fee_per_byte: "0x5",
        p50_fee_per_byte: "0x10",
        p90_fee_per_byte: "0x28",
        max_fee_per_byte: "0x40",
      }),
    };
    const client = new KovanicaClient({ transport: mockTransport });
    const controller = new AbortController();

    const stats = await client.getMempoolStats({ signal: controller.signal });
    expect(stats).toEqual({
      pendingCount: 7,
      totalBytes: 2048,
      minFeePerByte: 5n,
      p50FeePerByte: 16n,
      p90FeePerByte: 40n,
      maxFeePerByte: 64n,
    });
    expect(mockTransport.send).toHaveBeenCalledWith(
      "kovanica_mempoolStats",
      [],
      { signal: controller.signal },
    );
  });

  it("handles empty mempool response from kovanica_mempoolStats", async () => {
    const mockTransport: Transport = {
      send: vi.fn().mockResolvedValue({
        pending_count: 0,
        total_bytes: 0,
        min_fee_per_byte: null,
        p50_fee_per_byte: null,
        p90_fee_per_byte: null,
        max_fee_per_byte: null,
      }),
    };
    const client = new KovanicaClient({ transport: mockTransport });

    const stats = await client.getMempoolStats();
    expect(stats).toEqual({
      pendingCount: 0,
      totalBytes: 0,
      minFeePerByte: null,
      p50FeePerByte: null,
      p90FeePerByte: null,
      maxFeePerByte: null,
    });
    expect(computeFeeRecommendations(stats)).toEqual({
      economy: 1n,
      standard: 2n,
      priority: 3n,
      source: "fallback",
    });
  });
});
