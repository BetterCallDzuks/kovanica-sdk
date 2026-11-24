import { describe, expect, it, vi } from "vitest";
import { KovanicaClient } from "../src/client";
import { KovanicaAbortError } from "../src/errors";
import {
  DEFAULT_ACCOUNT_TX_HISTORY_MAX_PAGES,
  type AccountTxHistoryClient,
  type GetTransactionHistoryParams,
  type RawAccountTxHistoryEntry,
  type RawAccountTxHistoryPage,
  getAccountTxHistory,
  parseAccountTxHistoryEntry,
} from "../src/history";
import type { Transport } from "../src/transport";

const ALICE = "kvnc1111111111111111111111111111111111111111111111111111111111dag";
const BOB = "kvnc2222222222222222222222222222222222222222222222222222222222dag";

function makeRawEntry(
  overrides?: Partial<RawAccountTxHistoryEntry>,
): RawAccountTxHistoryEntry {
  return {
    hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    height: "0x6f",
    timestamp: "0x65a00000",
    from: ALICE,
    to: BOB,
    amount: "0x3b9aca00", // 1_000_000_000 (1 KVNC)
    fee: "0x3e8", // 1000
    kind: "transfer",
    status: "success",
    ...overrides,
  };
}

describe("getAccountTxHistory", () => {
  it("paginates across multiple pages until next_cursor is null using client.call()", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const pages: Record<string, RawAccountTxHistoryPage> = {
      initial: {
        entries: [
          makeRawEntry({ hash: "0x01", height: "0x10", amount: "0x64", fee: "0xa" }),
          makeRawEntry({ hash: "0x02", height: "0xf", amount: "0xc8", fee: "0xb" }),
        ],
        next_cursor: "cursor-page-2",
      },
      "cursor-page-2": {
        entries: [
          makeRawEntry({
            hash: "0x03",
            height: "0xe",
            to: null,
            timestamp: null,
            amount: "0x0",
            fee: "0xc",
            kind: "stake",
          }),
        ],
        next_cursor: "cursor-page-3",
      },
      "cursor-page-3": {
        entries: [
          makeRawEntry({
            hash: "0x04",
            height: "0xd",
            amount: "0x12c",
            fee: "0xd",
            status: "failed",
          }),
        ],
        next_cursor: null,
      },
    };

    const client: AccountTxHistoryClient = {
      async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
        calls.push({ method, params });
        const [req] = params as [GetTransactionHistoryParams];
        const key = req.cursor ?? "initial";
        return pages[key] as TResult;
      },
    };

    const result = await getAccountTxHistory(client, {
      address: ALICE,
      limit: 2,
    });

    expect(result.pagesFetched).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.items).toHaveLength(4);
    expect(result.items.map((tx) => tx.hash)).toEqual(["0x01", "0x02", "0x03", "0x04"]);
    expect(result.items[0]).toEqual({
      hash: "0x01",
      height: 16n,
      timestamp: 0x65a00000n,
      from: ALICE,
      to: BOB,
      amount: 100n,
      fee: 10n,
      kind: "transfer",
      status: "success",
    });
    expect(result.items[2].to).toBeNull();
    expect(result.items[2].timestamp).toBeNull();
    expect(result.items[2].kind).toBe("stake");
    expect(result.items[3].status).toBe("failed");

    expect(calls).toEqual([
      { method: "kovanica_getTransactionHistory", params: [{ address: ALICE, limit: 2 }] },
      {
        method: "kovanica_getTransactionHistory",
        params: [{ address: ALICE, limit: 2, cursor: "cursor-page-2" }],
      },
      {
        method: "kovanica_getTransactionHistory",
        params: [{ address: ALICE, limit: 2, cursor: "cursor-page-3" }],
      },
    ]);
  });

  it("stops at maxPages and returns hasMore=true with nextCursor for resumption", async () => {
    const getTransactionHistory = vi.fn(
      async (params: GetTransactionHistoryParams): Promise<RawAccountTxHistoryPage> => {
        const pageNum = params.cursor ? Number(params.cursor.replace("p", "")) : 1;
        return {
          entries: [makeRawEntry({ hash: `0x0${pageNum}`, height: pageNum })],
          next_cursor: `p${pageNum + 1}`,
        };
      },
    );

    const client: AccountTxHistoryClient = { getTransactionHistory };

    const firstBatch = await getAccountTxHistory(client, {
      address: ALICE,
      limit: 1,
      maxPages: 2,
    });

    expect(firstBatch.pagesFetched).toBe(2);
    expect(firstBatch.hasMore).toBe(true);
    expect(firstBatch.nextCursor).toBe("p3");
    expect(firstBatch.items.map((tx) => tx.hash)).toEqual(["0x01", "0x02"]);

    // Resume from returned nextCursor
    const secondBatch = await getAccountTxHistory(client, {
      address: ALICE,
      limit: 1,
      maxPages: 1,
      cursor: firstBatch.nextCursor!,
    });

    expect(secondBatch.pagesFetched).toBe(1);
    expect(secondBatch.hasMore).toBe(true);
    expect(secondBatch.nextCursor).toBe("p4");
    expect(secondBatch.items.map((tx) => tx.hash)).toEqual(["0x03"]);
  });

  it("defaults maxPages to DEFAULT_ACCOUNT_TX_HISTORY_MAX_PAGES (10)", async () => {
    let counter = 0;
    const client: AccountTxHistoryClient = {
      async getTransactionHistory(): Promise<RawAccountTxHistoryPage> {
        counter += 1;
        return {
          entries: [makeRawEntry({ hash: `0x${counter.toString(16)}` })],
          next_cursor: `c-${counter}`,
        };
      },
    };

    const result = await getAccountTxHistory(client, { address: ALICE });
    expect(result.pagesFetched).toBe(DEFAULT_ACCOUNT_TX_HISTORY_MAX_PAGES);
    expect(result.pagesFetched).toBe(10);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("c-10");
    expect(result.items).toHaveLength(10);
  });

  it("forwards direction filter ('sent', 'received', 'all') accurately", async () => {
    const seenDirections: Array<string | undefined> = [];
    const client: AccountTxHistoryClient = {
      async getTransactionHistory(
        params: GetTransactionHistoryParams,
      ): Promise<RawAccountTxHistoryPage> {
        seenDirections.push(params.direction);
        return { entries: [], next_cursor: null };
      },
    };

    await getAccountTxHistory(client, { address: ALICE, direction: "sent" });
    await getAccountTxHistory(client, { address: ALICE, direction: "received" });
    await getAccountTxHistory(client, { address: ALICE, direction: "all" });
    await getAccountTxHistory(client, { address: ALICE });

    expect(seenDirections).toEqual(["sent", "received", "all", undefined]);
  });

  it("parses amount, fee, height, and timestamp losslessly into bigint (including > Number.MAX_SAFE_INTEGER)", async () => {
    // 2^64 - 1 = 18446744073709551615 (well above Number.MAX_SAFE_INTEGER = 9007199254740991)
    const u64MaxHex = "0xffffffffffffffff";
    const u64MaxBig = 18_446_744_073_709_551_615n;
    // 100 billion KVNC in atoms = 100_000_000_000_000_000_000n (> u64 max, u128 range)
    const hugeDecimal = "100000000000000000000";
    const hugeBig = 100_000_000_000_000_000_000n;

    const client: AccountTxHistoryClient = {
      async getTransactionHistory(): Promise<RawAccountTxHistoryPage> {
        return {
          entries: [
            makeRawEntry({
              hash: "0xhex",
              height: u64MaxHex,
              timestamp: "0x1fffffffffffff", // Number.MAX_SAFE_INTEGER
              amount: u64MaxHex,
              fee: "0x100000000000001", // > MAX_SAFE_INTEGER
            }),
            makeRawEntry({
              hash: "0xdec",
              height: "9007199254740993", // MAX_SAFE_INTEGER + 2
              timestamp: "1700000000000000000",
              amount: hugeDecimal,
              fee: "9007199254740999",
            }),
            makeRawEntry({
              hash: "0xnum-and-bigint",
              height: 42,
              timestamp: 1_700_000_000,
              amount: 123_456_789,
              fee: 50_000n,
            }),
          ],
          next_cursor: null,
        };
      },
    };

    const result = await getAccountTxHistory(client, { address: ALICE });
    expect(result.items).toHaveLength(3);

    expect(result.items[0].height).toBe(u64MaxBig);
    expect(result.items[0].timestamp).toBe(9_007_199_254_740_991n);
    expect(result.items[0].amount).toBe(u64MaxBig);
    expect(result.items[0].fee).toBe(0x100000000000001n);

    expect(result.items[1].height).toBe(9_007_199_254_740_993n);
    expect(result.items[1].timestamp).toBe(1_700_000_000_000_000_000n);
    expect(result.items[1].amount).toBe(hugeBig);
    expect(result.items[1].fee).toBe(9_007_199_254_740_999n);

    expect(result.items[2].height).toBe(42n);
    expect(result.items[2].timestamp).toBe(1_700_000_000n);
    expect(result.items[2].amount).toBe(123_456_789n);
    expect(result.items[2].fee).toBe(50_000n);
  });

  it("rejects unsafe JS numbers > Number.MAX_SAFE_INTEGER to prevent silent precision loss", () => {
    expect(() =>
      parseAccountTxHistoryEntry(
        makeRawEntry({
          amount: Number.MAX_SAFE_INTEGER + 10,
        }),
      ),
    ).toThrow(TypeError);
  });

  it("handles empty results cleanly", async () => {
    const client: AccountTxHistoryClient = {
      async getTransactionHistory(): Promise<RawAccountTxHistoryPage> {
        return { entries: [], next_cursor: null };
      },
    };

    const result = await getAccountTxHistory(client, { address: ALICE });
    expect(result).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
      pagesFetched: 1,
    });
  });

  it("guards against duplicate cursor infinite loops (self-loop)", async () => {
    const getTransactionHistory = vi
      .fn<
        (params: GetTransactionHistoryParams) => Promise<RawAccountTxHistoryPage>
      >()
      .mockResolvedValueOnce({
        entries: [makeRawEntry({ hash: "0x01" })],
        next_cursor: "stuck-cursor",
      })
      .mockResolvedValueOnce({
        entries: [makeRawEntry({ hash: "0x02" })],
        next_cursor: "stuck-cursor", // repeats same cursor
      });

    const result = await getAccountTxHistory(
      { getTransactionHistory },
      { address: ALICE, maxPages: 10 },
    );

    expect(getTransactionHistory).toHaveBeenCalledTimes(2);
    expect(result.pagesFetched).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.items.map((tx) => tx.hash)).toEqual(["0x01", "0x02"]);
  });

  it("guards against multi-step cyclic cursor loops (A -> B -> A)", async () => {
    const getTransactionHistory = vi
      .fn<
        (params: GetTransactionHistoryParams) => Promise<RawAccountTxHistoryPage>
      >()
      .mockResolvedValueOnce({
        entries: [makeRawEntry({ hash: "0x01" })],
        next_cursor: "cursor-A",
      })
      .mockResolvedValueOnce({
        entries: [makeRawEntry({ hash: "0x02" })],
        next_cursor: "cursor-B",
      })
      .mockResolvedValueOnce({
        entries: [makeRawEntry({ hash: "0x03" })],
        next_cursor: "cursor-A", // cycle back to A
      });

    const result = await getAccountTxHistory(
      { getTransactionHistory },
      { address: ALICE, maxPages: 10 },
    );

    expect(getTransactionHistory).toHaveBeenCalledTimes(3);
    expect(result.pagesFetched).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.items.map((tx) => tx.hash)).toEqual(["0x01", "0x02", "0x03"]);
  });

  it("guards against a server repeating the initial caller-supplied cursor", async () => {
    const getTransactionHistory = vi.fn(
      async (): Promise<RawAccountTxHistoryPage> => ({
        entries: [makeRawEntry({ hash: "0x01" })],
        next_cursor: "start-cursor",
      }),
    );

    const result = await getAccountTxHistory(
      { getTransactionHistory },
      { address: ALICE, cursor: "start-cursor", maxPages: 5 },
    );

    expect(getTransactionHistory).toHaveBeenCalledTimes(1);
    expect(result.pagesFetched).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("works directly with KovanicaClient over a mocked Transport", async () => {
    const transport: Transport = {
      send: vi.fn(async (method: string, params?: unknown) => {
        expect(method).toBe("kovanica_getTransactionHistory");
        expect(params).toEqual([{ address: ALICE, direction: "sent", limit: 5 }]);
        return {
          entries: [makeRawEntry({ hash: "0xabc", amount: "0x2540be400" })],
          next_cursor: null,
        } as never;
      }),
    };

    const client = new KovanicaClient({ transport });
    const result = await getAccountTxHistory(client, {
      address: ALICE,
      direction: "sent",
      limit: 5,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].hash).toBe("0xabc");
    expect(result.items[0].amount).toBe(10_000_000_000n);
    expect(result.hasMore).toBe(false);
    expect(result.pagesFetched).toBe(1);
  });

  it("honors AbortSignal before and between page fetches", async () => {
    const controller = new AbortController();
    const getTransactionHistory = vi.fn(async (): Promise<RawAccountTxHistoryPage> => {
      controller.abort();
      return {
        entries: [makeRawEntry({ hash: "0x01" })],
        next_cursor: "page-2",
      };
    });

    await expect(
      getAccountTxHistory(
        { getTransactionHistory },
        { address: ALICE, maxPages: 5, signal: controller.signal },
      ),
    ).rejects.toThrow(KovanicaAbortError);

    expect(getTransactionHistory).toHaveBeenCalledTimes(1);
  });

  it("validates options fail-closed before issuing any RPC calls", async () => {
    const call = vi.fn();
    const client: AccountTxHistoryClient = { call };

    await expect(getAccountTxHistory(client, { address: "   " })).rejects.toThrow(TypeError);
    await expect(
      getAccountTxHistory(client, {
        address: ALICE,
        direction: "outgoing" as never,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      getAccountTxHistory(client, { address: ALICE, limit: -1 }),
    ).rejects.toThrow(RangeError);
    await expect(
      getAccountTxHistory(client, { address: ALICE, maxPages: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      getAccountTxHistory(client, { address: ALICE, cursor: "" }),
    ).rejects.toThrow(TypeError);

    expect(call).not.toHaveBeenCalled();
  });
});
