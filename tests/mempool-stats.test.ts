import { describe, expect, it, vi } from "vitest";
import { KovanicaClient } from "../src/client";
import {
  DEFAULT_RBF_BUMP_BPS,
  DEFAULT_RBF_MIN_BUMP_ATOMS,
  MAX_RBF_BUMP_BPS,
  MIN_RBF_BUMP_BPS,
  computeFeeRecommendations,
  computeRbfFeeBump,
  estimatePriorityFeeTiers,
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

describe("computeRbfFeeBump", () => {
  it("applies default +15% fee bump with ceiling division", () => {
    const exact = computeRbfFeeBump(100n);
    expect(exact).toEqual({
      previousFee: 100n,
      bumpedFee: 115n,
      delta: 15n,
      bumpBps: DEFAULT_RBF_BUMP_BPS,
    });

    // 101 * 1500 / 10000 = 15.15 -> ceil = 16
    const ceiled = computeRbfFeeBump(101n);
    expect(ceiled).toEqual({
      previousFee: 101n,
      bumpedFee: 117n,
      delta: 16n,
      bumpBps: 1_500,
    });
    expect(ceiled.bumpedFee > ceiled.previousFee).toBe(true);
  });

  it("strictly increments small 1n and 0n fees", () => {
    const oneAtom = computeRbfFeeBump(1n);
    expect(oneAtom).toEqual({
      previousFee: 1n,
      bumpedFee: 2n,
      delta: 1n,
      bumpBps: 1_500,
    });
    expect(oneAtom.bumpedFee > oneAtom.previousFee).toBe(true);

    const zeroAtom = computeRbfFeeBump(0n);
    expect(zeroAtom).toEqual({
      previousFee: 0n,
      bumpedFee: DEFAULT_RBF_MIN_BUMP_ATOMS,
      delta: 1n,
      bumpBps: 1_500,
    });
    expect(zeroAtom.bumpedFee > zeroAtom.previousFee).toBe(true);
  });

  it("respects custom bumpBps boundaries and minBumpAtoms floor", () => {
    const minBump = computeRbfFeeBump(10n, {
      bumpBps: MIN_RBF_BUMP_BPS,
      minBumpAtoms: 5n,
    });
    expect(minBump).toEqual({
      previousFee: 10n,
      bumpedFee: 15n,
      delta: 5n,
      bumpBps: 100,
    });

    const maxBump = computeRbfFeeBump(1_000n, {
      bumpBps: MAX_RBF_BUMP_BPS,
    });
    expect(maxBump).toEqual({
      previousFee: 1_000n,
      bumpedFee: 6_000n,
      delta: 5_000n,
      bumpBps: 50_000,
    });
  });

  it("handles large bigint fees exceeding Number.MAX_SAFE_INTEGER without precision loss", () => {
    const hugeFee = 100_000_000_000_000_000_001n;
    const res = computeRbfFeeBump(hugeFee);
    // ceil(100_000_000_000_000_000_001 * 1500 / 10000) = 15_000_000_000_000_000_001
    expect(res.delta).toBe(15_000_000_000_000_000_001n);
    expect(res.bumpedFee).toBe(115_000_000_000_000_000_002n);
    expect(res.bumpedFee > res.previousFee).toBe(true);
  });

  it("rejects invalid previousFee, bumpBps, and minBumpAtoms inputs", () => {
    expect(() => computeRbfFeeBump(-1n)).toThrow(RangeError);
    expect(() => computeRbfFeeBump(100 as unknown as bigint)).toThrow(TypeError);

    expect(() => computeRbfFeeBump(100n, { bumpBps: 99 })).toThrow(RangeError);
    expect(() => computeRbfFeeBump(100n, { bumpBps: 0 })).toThrow(RangeError);
    expect(() => computeRbfFeeBump(100n, { bumpBps: -100 })).toThrow(RangeError);
    expect(() => computeRbfFeeBump(100n, { bumpBps: 50_001 })).toThrow(RangeError);
    expect(() => computeRbfFeeBump(100n, { bumpBps: 1_500.5 })).toThrow(RangeError);
    expect(() => computeRbfFeeBump(100n, { bumpBps: Number.NaN })).toThrow(RangeError);

    expect(() => computeRbfFeeBump(100n, { minBumpAtoms: 0n })).toThrow(RangeError);
    expect(() => computeRbfFeeBump(100n, { minBumpAtoms: -5n })).toThrow(RangeError);
    expect(() =>
      computeRbfFeeBump(100n, { minBumpAtoms: 1 as unknown as bigint }),
    ).toThrow(TypeError);
  });
});

describe("estimatePriorityFeeTiers", () => {
  it("computes low congestion tiers via KovanicaClient with lossless bigint and KVNC formatting", async () => {
    const mockTransport: Transport = {
      send: vi.fn().mockResolvedValue({
        pending_count: 12,
        total_bytes: 4096,
        min_fee_per_byte: "1000000", // 0.001 KVNC
        p50_fee_per_byte: "2000000", // 0.002 KVNC -> *1.2 = 2_400_000 (0.0024 KVNC)
        p90_fee_per_byte: "5000000", // 0.005 KVNC -> *1.2 = 6_000_000 (0.006 KVNC)
        max_fee_per_byte: "10000000",
      }),
    };
    const client = new KovanicaClient({ transport: mockTransport });

    const estimate = await estimatePriorityFeeTiers(client);

    expect(estimate.pendingCount).toBe(12);
    expect(estimate.congestionLevel).toBe("low");
    expect(estimate.source).toBe("mempool");
    expect(estimate.slow).toEqual({
      tier: "slow",
      feeAtoms: 1_000_000n,
      feeKvnc: "0.001",
      feePerByte: 1_000_000n,
      estimatedInclusionBlocks: 3,
    });
    expect(estimate.standard).toEqual({
      tier: "standard",
      feeAtoms: 2_400_000n,
      feeKvnc: "0.0024",
      feePerByte: 2_400_000n,
      estimatedInclusionBlocks: 2,
    });
    expect(estimate.fast).toEqual({
      tier: "fast",
      feeAtoms: 6_000_000n,
      feeKvnc: "0.006",
      feePerByte: 6_000_000n,
      estimatedInclusionBlocks: 1,
    });
    expect(estimate.slow.feeAtoms <= estimate.standard.feeAtoms).toBe(true);
    expect(estimate.standard.feeAtoms <= estimate.fast.feeAtoms).toBe(true);
  });

  it("classifies moderate congestion via minimal RPC caller and forwards requestOptions", async () => {
    const callMock = vi.fn().mockResolvedValue({
      pending_count: 75,
      total_bytes: 32_768,
      min_fee_per_byte: "0x10",
      p50_fee_per_byte: "0x20",
      p90_fee_per_byte: "0x40",
      max_fee_per_byte: "0x80",
    });
    const controller = new AbortController();

    const estimate = await estimatePriorityFeeTiers(
      { call: callMock },
      { requestOptions: { signal: controller.signal } },
    );

    expect(callMock).toHaveBeenCalledWith(
      "kovanica_mempoolStats",
      [],
      { signal: controller.signal },
    );
    expect(estimate.pendingCount).toBe(75);
    expect(estimate.congestionLevel).toBe("moderate");
    expect(estimate.slow.estimatedInclusionBlocks).toBe(6);
    expect(estimate.standard.estimatedInclusionBlocks).toBe(3);
    expect(estimate.fast.estimatedInclusionBlocks).toBe(1);
    expect(estimate.slow.feeAtoms <= estimate.standard.feeAtoms).toBe(true);
    expect(estimate.standard.feeAtoms <= estimate.fast.feeAtoms).toBe(true);
  });

  it("classifies high congestion and scales lossless fees by txSizeBytes", async () => {
    const callMock = vi.fn().mockResolvedValue({
      pending_count: 250,
      total_bytes: 262_144,
      min_fee_per_byte: "10000000000000000", // 10^16 atoms/byte (> MAX_SAFE_INTEGER)
      p50_fee_per_byte: "20000000000000000",
      p90_fee_per_byte: "50000000000000000",
      max_fee_per_byte: "100000000000000000",
    });

    const estimate = await estimatePriorityFeeTiers(
      { call: callMock },
      { txSizeBytes: 250 },
    );

    expect(estimate.pendingCount).toBe(250);
    expect(estimate.congestionLevel).toBe("high");
    expect(estimate.slow.estimatedInclusionBlocks).toBe(12);
    expect(estimate.standard.estimatedInclusionBlocks).toBe(5);
    expect(estimate.fast.estimatedInclusionBlocks).toBe(2);
    expect(estimate.slow.feeAtoms).toBe(2_500_000_000_000_000_000n);
    expect(estimate.standard.feeAtoms).toBe(6_000_000_000_000_000_000n);
    expect(estimate.fast.feeAtoms).toBe(15_000_000_000_000_000_000n);
    expect(estimate.slow.feeKvnc).toBe("2500000000");
    expect(estimate.slow.feeAtoms <= estimate.standard.feeAtoms).toBe(true);
    expect(estimate.standard.feeAtoms <= estimate.fast.feeAtoms).toBe(true);
  });

  it("handles empty mempool fallback with monotonic slow <= standard <= fast tiers", async () => {
    const callMock = vi.fn().mockResolvedValue({
      pending_count: 0,
      total_bytes: 0,
      min_fee_per_byte: null,
      p50_fee_per_byte: null,
      p90_fee_per_byte: null,
      max_fee_per_byte: null,
    });

    const estimate = await estimatePriorityFeeTiers(
      { call: callMock },
      { fallbackBaseFeePerByte: 100n, safetyMultiplierBps: 12_500 },
    );

    expect(estimate.source).toBe("fallback");
    expect(estimate.pendingCount).toBe(0);
    expect(estimate.congestionLevel).toBe("low");
    expect(estimate.slow.feeAtoms).toBe(100n);
    expect(estimate.standard.feeAtoms).toBe(125n);
    expect(estimate.fast.feeAtoms).toBe(157n);
    expect(estimate.slow.feeAtoms <= estimate.standard.feeAtoms).toBe(true);
    expect(estimate.standard.feeAtoms <= estimate.fast.feeAtoms).toBe(true);
  });

  it("guarantees monotonic slow <= standard <= fast even with inverted mempool percentiles", async () => {
    const callMock = vi.fn().mockResolvedValue({
      pending_count: 5,
      total_bytes: 1024,
      min_fee_per_byte: 500,
      p50_fee_per_byte: 100,
      p90_fee_per_byte: 50,
      max_fee_per_byte: 500,
    });

    const estimate = await estimatePriorityFeeTiers({ call: callMock });
    expect(estimate.slow.feeAtoms).toBe(500n);
    expect(estimate.standard.feeAtoms).toBe(500n);
    expect(estimate.fast.feeAtoms).toBe(500n);
    expect(estimate.slow.feeAtoms <= estimate.standard.feeAtoms).toBe(true);
    expect(estimate.standard.feeAtoms <= estimate.fast.feeAtoms).toBe(true);
  });

  it("validates client and tier estimation options", async () => {
    const validClient = {
      call: vi.fn().mockResolvedValue({ pending_count: 0, total_bytes: 0 }),
    };

    await expect(
      estimatePriorityFeeTiers({} as unknown as { call: typeof validClient.call }),
    ).rejects.toThrow(TypeError);
    await expect(
      estimatePriorityFeeTiers(validClient, { txSizeBytes: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      estimatePriorityFeeTiers(validClient, { txSizeBytes: 0n }),
    ).rejects.toThrow(RangeError);
    await expect(
      estimatePriorityFeeTiers(validClient, { moderateCongestionThreshold: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      estimatePriorityFeeTiers(validClient, {
        moderateCongestionThreshold: 100,
        highCongestionThreshold: 50,
      }),
    ).rejects.toThrow(RangeError);
  });
});
