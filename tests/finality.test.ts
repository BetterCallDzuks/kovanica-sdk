import { describe, expect, it, vi } from "vitest";
import { KovanicaAbortError, KovanicaError, KovanicaTimeoutError } from "../src/errors";
import {
  DEFAULT_FEE_BUFFER_MULTIPLIER_BPS,
  applyFeeBuffer,
  estimateTxFeeWithBuffer,
  waitForTransactionFinality,
  type FinalityProgress,
} from "../src/finality";
import type { TransactionReceipt } from "../src/types";

const VALID_TX_HASH = `0x${"ab".repeat(32)}`;
const VALID_TX_HASH_NO_PREFIX = "AB".repeat(32);

function makeReceipt(blockNumber: bigint): TransactionReceipt {
  return {
    transactionHash: VALID_TX_HASH,
    blockHash: `0x${"cd".repeat(32)}`,
    blockNumber,
    transactionIndex: 0n,
    status: 1,
    success: true,
    gasUsed: 21_000n,
  };
}

describe("applyFeeBuffer", () => {
  it("applies default 1.2x (12_000 bps) safety multiplier with ceiling rounding", () => {
    expect(applyFeeBuffer(0n)).toEqual({
      baseFee: 0n,
      bufferedFee: 0n,
      safetyMultiplierBps: DEFAULT_FEE_BUFFER_MULTIPLIER_BPS,
      capped: false,
    });

    // 1 * 1.2 = 1.2 -> ceil = 2
    expect(applyFeeBuffer(1n)).toEqual({
      baseFee: 1n,
      bufferedFee: 2n,
      safetyMultiplierBps: 12_000,
      capped: false,
    });

    // 10 * 1.2 = 12 exact
    expect(applyFeeBuffer(10n)).toEqual({
      baseFee: 10n,
      bufferedFee: 12n,
      safetyMultiplierBps: 12_000,
      capped: false,
    });

    // 101 * 1.2 = 121.2 -> ceil = 122
    expect(applyFeeBuffer(101n)).toEqual({
      baseFee: 101n,
      bufferedFee: 122n,
      safetyMultiplierBps: 12_000,
      capped: false,
    });
  });

  it("supports custom safetyMultiplierBps including 1.0x (10_000 bps) and large bigint values", () => {
    const huge = 10_000_000_000_000_000_001n;
    expect(applyFeeBuffer(huge, { safetyMultiplierBps: 10_000 })).toEqual({
      baseFee: huge,
      bufferedFee: huge,
      safetyMultiplierBps: 10_000,
      capped: false,
    });

    // 100 * 1.3333 = 133.33 -> ceil = 134
    expect(applyFeeBuffer(100n, { safetyMultiplierBps: 13_333 })).toEqual({
      baseFee: 100n,
      bufferedFee: 134n,
      safetyMultiplierBps: 13_333,
      capped: false,
    });
  });

  it("enforces minFeePerByte floor and maxFeeCap ceiling", () => {
    expect(
      applyFeeBuffer(5n, {
        safetyMultiplierBps: 12_000,
        minFeePerByte: 50n,
      }),
    ).toEqual({
      baseFee: 5n,
      bufferedFee: 50n,
      safetyMultiplierBps: 12_000,
      capped: false,
    });

    expect(
      applyFeeBuffer(100n, {
        safetyMultiplierBps: 15_000,
        maxFeeCap: 120n,
      }),
    ).toEqual({
      baseFee: 100n,
      bufferedFee: 120n,
      safetyMultiplierBps: 15_000,
      capped: true,
    });

    // Exact match to maxFeeCap is not considered capped
    expect(
      applyFeeBuffer(100n, {
        safetyMultiplierBps: 12_000,
        maxFeeCap: 120n,
      }),
    ).toEqual({
      baseFee: 100n,
      bufferedFee: 120n,
      safetyMultiplierBps: 12_000,
      capped: false,
    });
  });

  it("rejects negative fees, multipliers < 10_000 bps, and invalid bounds", () => {
    expect(() => applyFeeBuffer(-1n)).toThrow(RangeError);
    expect(() => applyFeeBuffer(100n, { safetyMultiplierBps: 9_999 })).toThrow(RangeError);
    expect(() => applyFeeBuffer(100n, { safetyMultiplierBps: 12_000.5 })).toThrow(RangeError);
    expect(() => applyFeeBuffer(100n, { safetyMultiplierBps: Number.NaN })).toThrow(RangeError);
    expect(() => applyFeeBuffer(100n, { minFeePerByte: -1n })).toThrow(RangeError);
    expect(() => applyFeeBuffer(100n, { maxFeeCap: -1n })).toThrow(RangeError);
    expect(() =>
      applyFeeBuffer(100n, { minFeePerByte: 200n, maxFeeCap: 100n }),
    ).toThrow(RangeError);
  });
});

describe("estimateTxFeeWithBuffer", () => {
  it("adapts to KovanicaClient-style estimateFee(options?) returning bigint", async () => {
    const estimateFee = vi.fn().mockResolvedValue(250n);
    const client = { estimateFee };

    const result = await estimateTxFeeWithBuffer(
      client,
      { timeoutMs: 5_000 },
      { safetyMultiplierBps: 12_500 },
    );

    expect(estimateFee).toHaveBeenCalledWith({ timeoutMs: 5_000 });
    // 250 * 1.25 = 312.5 -> ceil = 313
    expect(result).toEqual({
      baseFee: 250n,
      bufferedFee: 313n,
      safetyMultiplierBps: 12_500,
      capped: false,
      raw: 250n,
    });
  });

  it("calls estimateFee() without arguments when params are omitted and extracts object fee payloads", async () => {
    const rawResponse = { feePerByte: "0x64", unit: "atoms" };
    const estimateFee = vi.fn().mockResolvedValue(rawResponse);
    const client = { estimateFee };

    const result = await estimateTxFeeWithBuffer(client, undefined, {
      maxFeeCap: 110n,
    });

    expect(estimateFee).toHaveBeenCalledWith();
    expect(result).toEqual({
      baseFee: 100n,
      bufferedFee: 110n,
      safetyMultiplierBps: 12_000,
      capped: true,
      raw: rawResponse,
    });
  });
});

describe("waitForTransactionFinality", () => {
  it("tracks pending -> included -> finalized progression with onProgress callbacks", async () => {
    let clock = 1_000;
    const now = () => clock;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });

    const receipt = makeReceipt(100n);
    const getTransactionReceipt = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(receipt)
      .mockResolvedValueOnce(receipt)
      .mockResolvedValueOnce(receipt);

    const getBlockNumber = vi
      .fn()
      .mockResolvedValueOnce(100n) // 1 confirmation (included)
      .mockResolvedValueOnce(101n) // 2 confirmations (included)
      .mockResolvedValueOnce(102n); // 3 confirmations (finalized)

    const progress: FinalityProgress[] = [];
    const result = await waitForTransactionFinality(
      { getTransactionReceipt, getBlockNumber },
      VALID_TX_HASH_NO_PREFIX,
      {
        confirmations: 3,
        pollIntervalMs: 500,
        timeoutMs: 10_000,
        now,
        sleep,
        onProgress: (update) => progress.push(update),
      },
    );

    expect(result).toEqual({
      txHash: VALID_TX_HASH,
      receipt,
      confirmations: 3,
      blockHeight: 100n,
      currentHeight: 102n,
      elapsedMs: 1_500,
    });

    expect(progress).toEqual([
      {
        txHash: VALID_TX_HASH,
        status: "pending",
        confirmations: 0,
        targetConfirmations: 3,
        elapsedMs: 0,
      },
      {
        txHash: VALID_TX_HASH,
        status: "included",
        confirmations: 1,
        targetConfirmations: 3,
        blockHeight: 100n,
        currentHeight: 100n,
        elapsedMs: 500,
      },
      {
        txHash: VALID_TX_HASH,
        status: "included",
        confirmations: 2,
        targetConfirmations: 3,
        blockHeight: 100n,
        currentHeight: 101n,
        elapsedMs: 1_000,
      },
      {
        txHash: VALID_TX_HASH,
        status: "finalized",
        confirmations: 3,
        targetConfirmations: 3,
        blockHeight: 100n,
        currentHeight: 102n,
        elapsedMs: 1_500,
      },
    ]);

    expect(getTransactionReceipt).toHaveBeenCalledTimes(4);
    expect(getBlockNumber).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("supports KovanicaClient-style blockNumber() and snake_case block_height receipts", async () => {
    const rawReceipt = { block_height: "0x32", status: 1 };
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue(rawReceipt),
      blockNumber: vi.fn().mockResolvedValue(50n),
    };

    const result = await waitForTransactionFinality(client, VALID_TX_HASH, {
      confirmations: 1,
      now: () => 5_000,
    });

    expect(result).toEqual({
      txHash: VALID_TX_HASH,
      receipt: rawReceipt,
      confirmations: 1,
      blockHeight: 50n,
      currentHeight: 50n,
      elapsedMs: 0,
    });
  });

  it("aborts immediately when AbortSignal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const getTransactionReceipt = vi.fn();
    const getBlockNumber = vi.fn();

    await expect(
      waitForTransactionFinality(
        { getTransactionReceipt, getBlockNumber },
        VALID_TX_HASH,
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(KovanicaAbortError);

    expect(getTransactionReceipt).not.toHaveBeenCalled();
    expect(getBlockNumber).not.toHaveBeenCalled();
  });

  it("aborts mid-flight during poll sleep", async () => {
    const controller = new AbortController();
    const getTransactionReceipt = vi.fn().mockResolvedValue(null);
    const getBlockNumber = vi.fn();

    const promise = waitForTransactionFinality(
      { getTransactionReceipt, getBlockNumber },
      VALID_TX_HASH,
      {
        pollIntervalMs: 5_000,
        timeoutMs: 60_000,
        signal: controller.signal,
        onProgress: () => {
          queueMicrotask(() => controller.abort());
        },
      },
    );

    await expect(promise).rejects.toBeInstanceOf(KovanicaAbortError);
    expect(getTransactionReceipt).toHaveBeenCalledTimes(1);
  });

  it("rejects with KovanicaTimeoutError when timeoutMs elapses", async () => {
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });

    const getTransactionReceipt = vi.fn().mockResolvedValue(null);
    const getBlockNumber = vi.fn();

    await expect(
      waitForTransactionFinality(
        { getTransactionReceipt, getBlockNumber },
        VALID_TX_HASH,
        {
          pollIntervalMs: 400,
          timeoutMs: 1_000,
          now: () => clock,
          sleep,
        },
      ),
    ).rejects.toBeInstanceOf(KovanicaTimeoutError);

    expect(clock).toBe(1_000);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid txHash and invalid option values", async () => {
    const client = {
      getTransactionReceipt: vi.fn(),
      getBlockNumber: vi.fn(),
    };

    await expect(waitForTransactionFinality(client, "0x1234")).rejects.toBeInstanceOf(
      KovanicaError,
    );
    await expect(
      waitForTransactionFinality(client, `0x${"zz".repeat(32)}`),
    ).rejects.toBeInstanceOf(KovanicaError);
    await expect(
      waitForTransactionFinality(client, VALID_TX_HASH, { confirmations: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      waitForTransactionFinality(client, VALID_TX_HASH, { pollIntervalMs: -1 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      waitForTransactionFinality(client, VALID_TX_HASH, { timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
