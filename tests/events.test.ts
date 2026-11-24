import { describe, expect, it, vi } from "vitest";
import { TESTNET_ADDRESS_PREFIX, encodeAddress } from "../src/address";
import { KovanicaClient } from "../src/client";
import { bytesToHex, concatBytes, u64le, u128le } from "../src/contracts";
import { KovanicaDecodeError } from "../src/decoders";
import { KovanicaAbortError } from "../src/errors";
import {
  type ContractLogEntry,
  DEFAULT_CONTRACT_LOGS_MAX_PAGES,
  DEFAULT_CONTRACT_LOGS_MAX_SPAN,
  DEFAULT_CONTRACT_LOGS_PAGE_LIMIT,
  DEFAULT_LOG_HISTORY_CHUNK_SIZE,
  type DecodedContractEvent,
  type GetLogsClient,
  type GetLogsFilter,
  type PaginatedGetLogsRpcFilter,
  type PaginatedLogsClient,
  type SubscribeLogsWsClient,
  formatContractLogCursor,
  getContractLogHistory,
  parseContractLogCursor,
  queryContractLogsPaginated,
  subscribeContractEvents,
} from "../src/events";
import type { Transport } from "../src/transport";
import { KovanicaWsClient, type WsLogReceipt } from "../src/ws";

// --- Deterministic Bincode Record Fixtures ---

function encodeHtlcFixture(overrides?: {
  senderByte?: number;
  claimerByte?: number;
  amount?: bigint;
  hashLockByte?: number;
  expiry?: bigint;
  claimed?: boolean;
  refunded?: boolean;
}): Uint8Array {
  const sender = new Uint8Array(32).fill(overrides?.senderByte ?? 0x11);
  const claimer = new Uint8Array(32).fill(overrides?.claimerByte ?? 0x22);
  const amount = u128le(overrides?.amount ?? 5_000_000_000n);
  const hashLock = new Uint8Array(32).fill(overrides?.hashLockByte ?? 0x33);
  const expiry = u64le(overrides?.expiry ?? 12_345n);
  const claimed = Uint8Array.of(overrides?.claimed ? 1 : 0);
  const refunded = Uint8Array.of(overrides?.refunded ? 1 : 0);
  return concatBytes([sender, claimer, amount, hashLock, expiry, claimed, refunded]);
}

function encodeEscrowFixture(overrides?: {
  creatorByte?: number;
  amount?: bigint;
  deadline?: bigint;
  released?: boolean;
  refunded?: boolean;
}): Uint8Array {
  const creator = new Uint8Array(32).fill(overrides?.creatorByte ?? 0xaa);
  const partyA = new Uint8Array(32).fill(0xbb);
  const partyB = new Uint8Array(32).fill(0xcc);
  const parties = concatBytes([u64le(2), partyA, partyB]);
  const threshold = Uint8Array.of(2);
  const approvals = concatBytes([u64le(1), partyA]);
  const amount = u128le(overrides?.amount ?? 9_000_000_000n);
  const deadline = u64le(overrides?.deadline ?? 99_999n);
  const released = Uint8Array.of(overrides?.released ? 1 : 0);
  const refunded = Uint8Array.of(overrides?.refunded ? 1 : 0);
  return concatBytes([creator, parties, threshold, approvals, amount, deadline, released, refunded]);
}

// --- Minimal Mock WebSocket for KovanicaWsClient Integration ---

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static lastInstance: MockWebSocket | null = null;

  readonly url: string;
  readyState: number = MockWebSocket.CONNECTING;
  sent: string[] = [];

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.lastInstance = this;
    queueMicrotask(() => {
      if (this.readyState === MockWebSocket.CONNECTING) {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.({} as Event);
      }
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  triggerMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  lastSentJson(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]!);
  }
}

describe("getContractLogHistory", () => {
  const sampleContractBytes = new Uint8Array(32).fill(0x42);
  const sampleContractAddress = encodeAddress(sampleContractBytes);
  const sampleTestnetAddress = encodeAddress(sampleContractBytes, TESTNET_ADDRESS_PREFIX);

  it("exports default chunk size of 1_000", () => {
    expect(DEFAULT_LOG_HISTORY_CHUNK_SIZE).toBe(1_000);
  });

  it("paginates multi-chunk ranges sequentially via client.call('kovanica_getLogs', ...)", async () => {
    const filters: GetLogsFilter[] = [];
    const send = vi.fn(async (method: string, params?: unknown) => {
      expect(method).toBe("kovanica_getLogs");
      const filter = (params as [GetLogsFilter])[0];
      filters.push(filter);
      return [
        {
          address: sampleContractAddress,
          topics: ["0x01"],
          data: `0x${bytesToHex(encodeHtlcFixture({ amount: BigInt(filters.length) }))}`,
          blockNumber: filter.fromBlock,
        },
      ];
    });
    const transport: Transport = { send };
    const client = new KovanicaClient({ transport });

    const result = await getContractLogHistory(client, {
      contract: sampleContractAddress,
      fromBlock: 100n,
      toBlock: 300n,
      chunkSize: 100,
      topics: ["0x01", null],
    });

    expect(result.chunksQueried).toBe(3);
    expect(result.fromBlock).toBe(100n);
    expect(result.toBlock).toBe(300n);
    expect(result.logs).toHaveLength(3);
    expect(result.decodedLogs).toEqual([]);
    expect(filters).toEqual([
      {
        fromBlock: "0x64",
        toBlock: "0xc7",
        address: sampleContractAddress,
        topics: ["0x01", null],
      },
      {
        fromBlock: "0xc8",
        toBlock: "0x12b",
        address: sampleContractAddress,
        topics: ["0x01", null],
      },
      {
        fromBlock: "0x12c",
        toBlock: "0x12c",
        address: sampleContractAddress,
        topics: ["0x01", null],
      },
    ]);
  });

  it("handles exact chunk boundaries: single block, exact multiple, chunkSize=1, and large bigint", async () => {
    const seenRanges: Array<[string, string]> = [];
    const client: GetLogsClient = {
      getLogs: vi.fn(async (filter: GetLogsFilter) => {
        seenRanges.push([filter.fromBlock, filter.toBlock]);
        return [];
      }),
    };

    // Single block [0, 0]
    const single = await getContractLogHistory(client, { fromBlock: 0, toBlock: 0 });
    expect(single.chunksQueried).toBe(1);
    expect(seenRanges).toEqual([["0x0", "0x0"]]);

    // Exact multiple [100, 299] with chunkSize 100 -> 2 chunks
    seenRanges.length = 0;
    const exact = await getContractLogHistory(client, {
      fromBlock: 100,
      toBlock: 299,
      chunkSize: 100,
    });
    expect(exact.chunksQueried).toBe(2);
    expect(seenRanges).toEqual([
      ["0x64", "0xc7"],
      ["0xc8", "0x12b"],
    ]);

    // chunkSize = 1 across [10, 12] -> 3 single-block chunks
    seenRanges.length = 0;
    const oneByOne = await getContractLogHistory(client, {
      fromBlock: 10n,
      toBlock: 12n,
      chunkSize: 1,
    });
    expect(oneByOne.chunksQueried).toBe(3);
    expect(seenRanges).toEqual([
      ["0xa", "0xa"],
      ["0xb", "0xb"],
      ["0xc", "0xc"],
    ]);

    // Large bigint > Number.MAX_SAFE_INTEGER
    seenRanges.length = 0;
    const base = 9_007_199_254_740_995n;
    const big = await getContractLogHistory(client, {
      fromBlock: base,
      toBlock: base + 4n,
      chunkSize: 2,
    });
    expect(big.chunksQueried).toBe(3);
    expect(big.fromBlock).toBe(base);
    expect(big.toBlock).toBe(base + 4n);
    expect(seenRanges).toEqual([
      [`0x${base.toString(16)}`, `0x${(base + 1n).toString(16)}`],
      [`0x${(base + 2n).toString(16)}`, `0x${(base + 3n).toString(16)}`],
      [`0x${(base + 4n).toString(16)}`, `0x${(base + 4n).toString(16)}`],
    ]);
  });

  it("accepts 32-byte Uint8Array, hex, and testnet tknc contract addresses", async () => {
    const receivedAddresses: Array<string | undefined> = [];
    const client: GetLogsClient = {
      getLogs: vi.fn(async (filter: GetLogsFilter) => {
        receivedAddresses.push(filter.address);
        return [];
      }),
    };

    await getContractLogHistory(client, {
      contract: sampleContractBytes,
      fromBlock: 1n,
      toBlock: 1n,
    });
    await getContractLogHistory(client, {
      contract: `0x${bytesToHex(sampleContractBytes)}`,
      fromBlock: 1n,
      toBlock: 1n,
    });
    await getContractLogHistory(client, {
      contract: sampleTestnetAddress,
      fromBlock: 1n,
      toBlock: 1n,
    });

    expect(receivedAddresses).toEqual([
      sampleContractAddress,
      sampleContractAddress,
      sampleTestnetAddress,
    ]);
  });

  it("decodes logs via static kind and resolver across multiple chunks", async () => {
    const htlcBytes = encodeHtlcFixture({ amount: 777n, expiry: 555n, claimed: true });
    const escrowBytes = encodeEscrowFixture({ amount: 888n, deadline: 666n, released: true });

    const chunks: ContractLogEntry[][] = [
      [
        {
          address: sampleContractAddress,
          topics: ["htlc"],
          data: `0x${bytesToHex(htlcBytes)}`,
        },
        {
          address: sampleContractAddress,
          topics: ["ignored"],
          data: "0xdeadbeef",
        },
      ],
      [
        {
          address: sampleContractAddress,
          topics: ["escrow"],
          data: Array.from(escrowBytes),
        },
      ],
    ];

    let callIdx = 0;
    const client: GetLogsClient = {
      getLogs: vi.fn(async () => chunks[callIdx++] ?? []),
    };

    // Resolver decoding mixed kinds and skipping unmatched log while preserving 0-based indices
    const mixed = await getContractLogHistory(client, {
      fromBlock: 0n,
      toBlock: 19n,
      chunkSize: 10,
      kind: (log) => {
        if (log.topics?.[0] === "htlc") return "htlc";
        if (log.topics?.[0] === "escrow") return "escrow";
        return null;
      },
    });

    expect(mixed.chunksQueried).toBe(2);
    expect(mixed.logs).toHaveLength(3);
    expect(mixed.decodedLogs).toHaveLength(2);
    expect(mixed.decodedLogs[0]?.index).toBe(0);
    expect(mixed.decodedLogs[0]?.kind).toBe("htlc");
    if (mixed.decodedLogs[0]?.kind === "htlc") {
      expect(mixed.decodedLogs[0].record.amount).toBe(777n);
      expect(mixed.decodedLogs[0].record.status).toBe("claimed");
    }
    expect(mixed.decodedLogs[1]?.index).toBe(2);
    expect(mixed.decodedLogs[1]?.kind).toBe("escrow");
    if (mixed.decodedLogs[1]?.kind === "escrow") {
      expect(mixed.decodedLogs[1].record.amount).toBe(888n);
      expect(mixed.decodedLogs[1].record.status).toBe("released");
    }

    // Static kind decoding
    const staticClient: GetLogsClient = {
      getLogs: vi.fn(async () => [
        { address: sampleContractAddress, data: htlcBytes },
      ]),
    };
    const staticResult = await getContractLogHistory(staticClient, {
      fromBlock: 5n,
      toBlock: 5n,
      kind: "htlc",
    });
    expect(staticResult.decodedLogs).toHaveLength(1);
    expect(staticResult.decodedLogs[0]?.kind).toBe("htlc");
    expect(staticResult.decodedLogs[0]?.record.expiry).toBe(555n);
  });

  it("honors AbortSignal before start and mid-pagination between chunks", async () => {
    const preAborted = new AbortController();
    preAborted.abort();

    const getLogsPre = vi.fn(async () => []);
    await expect(
      getContractLogHistory(
        { getLogs: getLogsPre },
        { fromBlock: 0n, toBlock: 100n, chunkSize: 10, signal: preAborted.signal },
      ),
    ).rejects.toBeInstanceOf(KovanicaAbortError);
    expect(getLogsPre).not.toHaveBeenCalled();

    // Abort during chunk 2 of 5 -> must stop before chunk 3
    const midController = new AbortController();
    let calls = 0;
    const getLogsMid = vi.fn(async () => {
      calls += 1;
      if (calls === 2) {
        midController.abort();
      }
      return [];
    });

    await expect(
      getContractLogHistory(
        { getLogs: getLogsMid },
        { fromBlock: 0n, toBlock: 49n, chunkSize: 10, signal: midController.signal },
      ),
    ).rejects.toBeInstanceOf(KovanicaAbortError);
    expect(calls).toBe(2);
  });

  it("validates invalid ranges, chunkSize, contract, and kind fail-closed before any RPC I/O", async () => {
    const getLogs = vi.fn(async () => []);
    const client: GetLogsClient = { getLogs };

    await expect(
      getContractLogHistory(client, { fromBlock: 10n, toBlock: 9n }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      getContractLogHistory(client, { fromBlock: -1n, toBlock: 5n }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      getContractLogHistory(client, { fromBlock: 0, toBlock: 1.5 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      getContractLogHistory(client, { fromBlock: 0, toBlock: 10, chunkSize: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      getContractLogHistory(client, { fromBlock: 0, toBlock: 10, chunkSize: -5 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      getContractLogHistory(client, { fromBlock: 0, toBlock: 10, chunkSize: 2.5 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      getContractLogHistory(client, {
        fromBlock: 0,
        toBlock: 10,
        contract: "kvnc_invalid_address",
      }),
    ).rejects.toThrow();
    await expect(
      getContractLogHistory(client, {
        fromBlock: 0,
        toBlock: 10,
        kind: "unknown_kind" as never,
      }),
    ).rejects.toBeInstanceOf(KovanicaDecodeError);
    await expect(
      getContractLogHistory({} as GetLogsClient, { fromBlock: 0, toBlock: 10 }),
    ).rejects.toBeInstanceOf(TypeError);

    expect(getLogs).not.toHaveBeenCalled();
  });
});

describe("subscribeContractEvents", () => {
  it("subscribes via KovanicaWsClient, decodes live WsLogReceipt events, isolates malformed frames, and unsubscribes cleanly", async () => {
    const wsClient = new KovanicaWsClient({
      url: "ws://127.0.0.1:8545/ws",
      WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });
    await wsClient.connect();
    const socket = MockWebSocket.lastInstance!;

    const received: Array<DecodedContractEvent<"htlc">> = [];
    const decodeErrors: Array<{ error: Error; rawLog: unknown }> = [];

    const subPromise = subscribeContractEvents(
      wsClient,
      {
        filter: { address: "kvnc_contract_filter" },
        kind: "htlc",
        onDecodeError: (error, rawLog) => {
          decodeErrors.push({ error, rawLog });
        },
      },
      (event) => {
        received.push(event);
      },
    );

    const subReq = socket.lastSentJson();
    expect(subReq.method).toBe("kovanica_subscribe");
    expect(subReq.params).toEqual(["logs", { address: "kvnc_contract_filter" }]);

    socket.triggerMessage({
      jsonrpc: "2.0",
      id: subReq.id,
      result: "sub_htlc_1",
    });

    const handle = await subPromise;
    expect(handle.subscriptionId).toBe("sub_htlc_1");

    const htlc1 = encodeHtlcFixture({ amount: 1_000n, expiry: 50n, claimed: false });
    const htlc2 = encodeHtlcFixture({ amount: 2_000n, expiry: 90n, refunded: true });

    // Deliver a batch containing: valid hex event, malformed event, and valid number[] byte-array event
    const receiptBatch: WsLogReceipt[] = [
      {
        tx_hash: "0xabc1",
        success: true,
        gas_used: 42_000,
        error: null,
        events: [
          {
            address: "kvnc_contract_filter",
            topic: "0x01",
            data: `0x${bytesToHex(htlc1)}`,
          },
          {
            address: "kvnc_contract_filter",
            topic: "0x02",
            data: "0xdeadbeef", // truncated -> triggers onDecodeError without crashing
          },
          {
            address: "kvnc_contract_filter",
            topic: "0x03",
            data: Array.from(htlc2),
          },
        ],
      },
    ];

    socket.triggerMessage({
      jsonrpc: "2.0",
      method: "kovanica_subscription",
      params: {
        subscription: "sub_htlc_1",
        result: receiptBatch,
      },
    });

    expect(received).toHaveLength(2);
    expect(received[0]?.kind).toBe("htlc");
    expect(received[0]?.record.amount).toBe(1_000n);
    expect(received[0]?.record.status).toBe("open");
    expect(received[0]?.receipt?.tx_hash).toBe("0xabc1");

    expect(received[1]?.kind).toBe("htlc");
    expect(received[1]?.record.amount).toBe(2_000n);
    expect(received[1]?.record.status).toBe("refunded");

    expect(decodeErrors).toHaveLength(1);
    expect(decodeErrors[0]?.error).toBeInstanceOf(KovanicaDecodeError);
    expect((decodeErrors[0]?.rawLog as { data: string }).data).toBe("0xdeadbeef");

    // Unsubscribe cleanly
    const unsubPromise = handle.unsubscribe();
    const unsubReq = socket.lastSentJson();
    expect(unsubReq.method).toBe("kovanica_unsubscribe");
    expect(unsubReq.params).toEqual(["sub_htlc_1"]);

    socket.triggerMessage({
      jsonrpc: "2.0",
      id: unsubReq.id,
      result: true,
    });

    expect(await unsubPromise).toBe(true);
    expect(wsClient.activeSubscriptionCount).toBe(0);
    wsClient.close();
  });

  it("ignores late events after unsubscribe and isolates malformed frames when onDecodeError is omitted", async () => {
    let pushCallback: ((payload: WsLogReceipt[]) => void) | undefined;
    const unsubscribeMock = vi.fn(async () => true);
    const wsClient: SubscribeLogsWsClient = {
      subscribeLogs: vi.fn(async (_filter, cb) => {
        pushCallback = cb;
        return "sub_mock_9";
      }),
      unsubscribe: unsubscribeMock,
    };

    const received: Array<DecodedContractEvent<"escrow">> = [];
    const handle = await subscribeContractEvents(
      wsClient,
      { kind: "escrow" },
      (ev) => received.push(ev),
    );

    const validEscrow = encodeEscrowFixture({ amount: 555n });

    // Malformed non-object frame + valid event in same subscription loop
    pushCallback?.(null as unknown as WsLogReceipt[]);
    pushCallback?.([
      {
        tx_hash: "0x1",
        success: true,
        gas_used: 100,
        error: null,
        events: [
          { address: "0x01", topic: "0x01", data: "not-hex" },
          { address: "0x01", topic: "0x01", data: `0x${bytesToHex(validEscrow)}` },
        ],
      },
    ]);

    expect(received).toHaveLength(1);
    expect(received[0]?.record.amount).toBe(555n);

    expect(await handle.unsubscribe()).toBe(true);
    expect(unsubscribeMock).toHaveBeenCalledWith("sub_mock_9");

    // Late frame after unsubscribe must not reach onEvent
    pushCallback?.([
      {
        tx_hash: "0x2",
        success: true,
        gas_used: 100,
        error: null,
        events: [{ address: "0x01", topic: "0x01", data: `0x${bytesToHex(validEscrow)}` }],
      },
    ]);
    expect(received).toHaveLength(1);
  });

  it("validates kind, wsClient, and callbacks fail-closed before calling subscribeLogs", async () => {
    const subscribeLogs = vi.fn(async () => "sub_unused");
    const wsClient: SubscribeLogsWsClient = {
      subscribeLogs,
      unsubscribe: vi.fn(async () => true),
    };

    await expect(
      subscribeContractEvents(wsClient, { kind: "bad_kind" as never }, () => {}),
    ).rejects.toBeInstanceOf(KovanicaDecodeError);

    await expect(
      subscribeContractEvents(wsClient, { kind: "htlc" }, null as never),
    ).rejects.toBeInstanceOf(TypeError);

    await expect(
      subscribeContractEvents(
        wsClient,
        { kind: "htlc", onDecodeError: "not_fn" as never },
        () => {},
      ),
    ).rejects.toBeInstanceOf(TypeError);

    await expect(
      subscribeContractEvents({} as SubscribeLogsWsClient, { kind: "htlc" }, () => {}),
    ).rejects.toBeInstanceOf(TypeError);

    expect(subscribeLogs).not.toHaveBeenCalled();
  });
});

describe("queryContractLogsPaginated", () => {
  const sampleContractBytes = new Uint8Array(32).fill(0x55);
  const sampleContractAddress = encodeAddress(sampleContractBytes);
  const sampleTestnetAddress = encodeAddress(sampleContractBytes, TESTNET_ADDRESS_PREFIX);

  it("exports expected pagination defaults and parses/formats cursors", () => {
    expect(DEFAULT_CONTRACT_LOGS_MAX_SPAN).toBe(500);
    expect(DEFAULT_CONTRACT_LOGS_MAX_PAGES).toBe(20);
    expect(DEFAULT_CONTRACT_LOGS_PAGE_LIMIT).toBe(200);

    expect(parseContractLogCursor("120:4")).toEqual({ height: 120n, logIndex: 4n });
    expect(parseContractLogCursor("0x78:0x04")).toEqual({ height: 120n, logIndex: 4n });
    expect(formatContractLogCursor(120n, 4n)).toBe("120:4");

    expect(() => parseContractLogCursor("bad")).toThrow(RangeError);
    expect(() => parseContractLogCursor("10:20:30")).toThrow(RangeError);
    expect(() => parseContractLogCursor("0x:1")).toThrow(RangeError);
    expect(() => parseContractLogCursor("-1:0")).toThrow(RangeError);
    expect(() => parseContractLogCursor(123 as never)).toThrow(TypeError);
  });

  it("chunks wide [fromBlock, toBlock] ranges into <= maxSpan windows via KovanicaClient", async () => {
    const seenFilters: PaginatedGetLogsRpcFilter[] = [];
    const send = vi.fn(async (method: string, params?: unknown) => {
      expect(method).toBe("kovanica_getLogs");
      const filter = (params as [PaginatedGetLogsRpcFilter])[0];
      seenFilters.push(filter);
      return [
        {
          address: sampleContractAddress,
          topics: ["0xaa"],
          data: "0x01",
          blockNumber: filter.fromBlock,
          logIndex: "0x0",
          transactionHash: `0xtx${seenFilters.length}`,
        },
      ];
    });
    const client = new KovanicaClient({ transport: { send } });

    const res = await queryContractLogsPaginated(
      client,
      {
        fromBlock: 100n,
        toBlock: 1_250n,
        address: [sampleContractBytes, sampleTestnetAddress],
        topics: ["0xaa", null],
      },
      { maxSpan: 500, pageLimit: 50 },
    );

    expect(res.chunksScanned).toBe(3);
    expect(res.pagesFetched).toBe(3);
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toBeNull();
    expect(res.decodedLogs).toBeUndefined();
    expect(res.logs).toHaveLength(3);
    expect(seenFilters).toEqual([
      {
        fromBlock: "0x64",
        toBlock: "0x257",
        address: [sampleContractAddress, sampleTestnetAddress],
        topics: ["0xaa", null],
        limit: 50,
      },
      {
        fromBlock: "0x258",
        toBlock: "0x44b",
        address: [sampleContractAddress, sampleTestnetAddress],
        topics: ["0xaa", null],
        limit: 50,
      },
      {
        fromBlock: "0x44c",
        toBlock: "0x4e2",
        address: [sampleContractAddress, sampleTestnetAddress],
        topics: ["0xaa", null],
        limit: 50,
      },
    ]);
  });

  it("paginates via derived cursor within a chunk and deduplicates boundary overlap", async () => {
    const requests: PaginatedGetLogsRpcFilter[] = [];
    const client: PaginatedLogsClient = {
      getLogs: vi.fn(async (filter: PaginatedGetLogsRpcFilter) => {
        requests.push(filter);
        if (!filter.cursor) {
          return [
            {
              address: sampleContractAddress,
              data: "0x01",
              blockNumber: "0xa",
              logIndex: "0x0",
              transactionHash: "0xtx1",
            },
            {
              address: sampleContractAddress,
              data: "0x02",
              blockNumber: "0xa",
              logIndex: "0x1",
              transactionHash: "0xtx1",
            },
          ];
        }
        if (filter.cursor === "10:1") {
          return [
            // Overlapping duplicate from boundary — must be deduplicated
            {
              address: sampleContractAddress,
              data: "0x02",
              blockNumber: "0xa",
              logIndex: "0x1",
              transactionHash: "0xtx1",
            },
            {
              address: sampleContractAddress,
              data: "0x03",
              blockNumber: "0x14",
              logIndex: "0x0",
              transactionHash: "0xtx2",
            },
          ];
        }
        if (filter.cursor === "20:0") {
          return [
            {
              address: sampleContractAddress,
              data: "0x04",
              blockNumber: "0x1e",
              logIndex: "0x2",
              transactionHash: "0xtx3",
            },
          ];
        }
        return [];
      }),
    };

    const res = await queryContractLogsPaginated(
      client,
      { fromBlock: 0, toBlock: 50 },
      { maxSpan: 100, pageLimit: 2, maxPages: 10 },
    );

    expect(res.chunksScanned).toBe(1);
    expect(res.pagesFetched).toBe(3);
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toBeNull();
    expect(res.logs.map((l) => l.data)).toEqual(["0x01", "0x02", "0x03", "0x04"]);
    expect(requests.map((r) => r.cursor)).toEqual([undefined, "10:1", "20:0"]);
  });

  it("deduplicates by (transactionHash, logIndex) when blockNumber is absent", async () => {
    let call = 0;
    const client: PaginatedLogsClient = {
      getLogs: vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return {
            logs: [
              { data: "0x01", transactionHash: "0xAAA", logIndex: "0x0" },
              { data: "0x02", transactionHash: "0xAAA", logIndex: "0x1" },
            ],
            nextCursor: "10:1",
          };
        }
        return {
          logs: [
            { data: "0x02", transactionHash: "0xaaa", logIndex: 1 },
            { data: "0x03", transactionHash: "0xbbb", logIndex: 0 },
          ],
          nextCursor: null,
        };
      }),
    };

    const res = await queryContractLogsPaginated(client, { fromBlock: 0, toBlock: 20 });
    expect(res.logs.map((l) => l.data)).toEqual(["0x01", "0x02", "0x03"]);
    expect(res.pagesFetched).toBe(2);
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toBeNull();
  });

  it("enforces maxPages cap and supports seamless cursor resumption mid-chunk and across chunks", async () => {
    const allLogs: ContractLogEntry[] = [
      { data: "0x01", blockNumber: "0xa", logIndex: "0x0" },
      { data: "0x02", blockNumber: "0xa", logIndex: "0x1" },
      { data: "0x03", blockNumber: "0x14", logIndex: "0x0" },
      { data: "0x04", blockNumber: "0x6e", logIndex: "0x0" }, // block 110 (chunk 2)
      { data: "0x05", blockNumber: "0xdc", logIndex: "0x0" }, // block 220 (chunk 3)
    ];

    const client: PaginatedLogsClient = {
      getLogs: vi.fn(async (filter: PaginatedGetLogsRpcFilter) => {
        const from = BigInt(filter.fromBlock);
        const to = BigInt(filter.toBlock);
        const cursor = filter.cursor ? parseContractLogCursor(filter.cursor) : null;
        const limit = filter.limit ?? 200;

        const matching = allLogs.filter((log) => {
          const h = BigInt(log.blockNumber as string);
          const idx = BigInt(log.logIndex as string);
          if (h < from || h > to) return false;
          if (cursor && (h < cursor.height || (h === cursor.height && idx <= cursor.logIndex))) {
            return false;
          }
          return true;
        });

        return matching.slice(0, limit);
      }),
    };

    // Pass 1: maxPages=1, pageLimit=2 -> stops mid-chunk after 2 logs with cursor "10:1"
    const p1 = await queryContractLogsPaginated(
      client,
      { fromBlock: 0, toBlock: 250 },
      { maxSpan: 100, maxPages: 1, pageLimit: 2 },
    );
    expect(p1.pagesFetched).toBe(1);
    expect(p1.chunksScanned).toBe(1);
    expect(p1.hasMore).toBe(true);
    expect(p1.nextCursor).toBe("10:1");
    expect(p1.logs.map((l) => l.data)).toEqual(["0x01", "0x02"]);

    // Pass 2: resume from "10:1" with maxPages=1 -> finishes chunk [10, 109] (gets 0x03), hits chunk boundary cap
    const p2 = await queryContractLogsPaginated(
      client,
      { fromBlock: 0, toBlock: 250, cursor: p1.nextCursor! },
      { maxSpan: 100, maxPages: 1, pageLimit: 2 },
    );
    expect(p2.pagesFetched).toBe(1);
    expect(p2.hasMore).toBe(true);
    expect(p2.nextCursor).toBe("109:18446744073709551615");
    expect(p2.logs.map((l) => l.data)).toEqual(["0x03"]);

    // Pass 3: resume from chunk-boundary cursor -> scans [110, 209] and [210, 250]
    const p3 = await queryContractLogsPaginated(
      client,
      { fromBlock: 0, toBlock: 250 },
      { cursor: p2.nextCursor!, maxSpan: 100, maxPages: 5, pageLimit: 2 },
    );
    expect(p3.hasMore).toBe(false);
    expect(p3.nextCursor).toBeNull();
    expect(p3.chunksScanned).toBe(2);
    expect(p3.logs.map((l) => l.data)).toEqual(["0x04", "0x05"]);

    // Cursor beyond toBlock returns empty with zero RPC calls
    const getLogsUnused = vi.fn(async () => []);
    const beyond = await queryContractLogsPaginated(
      { getLogs: getLogsUnused },
      { fromBlock: 0, toBlock: 50, cursor: "51:0" },
    );
    expect(beyond).toEqual({
      logs: [],
      nextCursor: null,
      hasMore: false,
      pagesFetched: 0,
      chunksScanned: 0,
    });
    expect(getLogsUnused).not.toHaveBeenCalled();
  });

  it("guards against cyclic or repeated cursors in both structured and raw-array responses", async () => {
    // Structured response repeating nextCursor "10:0"
    const cyclicStructured = vi.fn(async () => ({
      logs: [{ data: "0x01", blockNumber: "0xa", logIndex: "0x0" }],
      nextCursor: "10:0",
    }));
    const res1 = await queryContractLogsPaginated(
      { getLogs: cyclicStructured },
      { fromBlock: 0, toBlock: 50 },
      { maxPages: 10 },
    );
    expect(cyclicStructured).toHaveBeenCalledTimes(2);
    expect(res1.pagesFetched).toBe(2);
    expect(res1.hasMore).toBe(false);
    expect(res1.nextCursor).toBeNull();
    expect(res1.logs).toHaveLength(1);

    // Raw array response ignoring cursor and repeating same pageLimit logs
    const cyclicRaw = vi.fn(async () => [
      { data: "0x01", blockNumber: "0xa", logIndex: "0x0" },
      { data: "0x02", blockNumber: "0xa", logIndex: "0x1" },
    ]);
    const res2 = await queryContractLogsPaginated(
      { getLogs: cyclicRaw },
      { fromBlock: 0, toBlock: 50 },
      { maxPages: 10, pageLimit: 2 },
    );
    expect(cyclicRaw).toHaveBeenCalledTimes(2);
    expect(res2.pagesFetched).toBe(2);
    expect(res2.hasMore).toBe(false);
    expect(res2.nextCursor).toBeNull();
    expect(res2.logs).toHaveLength(2);
  });

  it("decodes collected logs via decodeContractLog when decode is enabled", async () => {
    const htlcBytes = encodeHtlcFixture({ amount: 4242n, expiry: 900n, claimed: true });
    const escrowBytes = encodeEscrowFixture({ amount: 9090n, deadline: 1234n, released: true });

    const client: PaginatedLogsClient = {
      getLogs: vi.fn(async () => [
        {
          address: sampleContractAddress,
          topics: ["htlc"],
          data: `0x${bytesToHex(htlcBytes)}`,
          blockNumber: "0x1",
          logIndex: "0x0",
        },
        {
          address: sampleContractAddress,
          topics: ["other"],
          data: "0xdeadbeef",
          blockNumber: "0x1",
          logIndex: "0x1",
        },
        {
          address: sampleContractAddress,
          topics: ["escrow"],
          data: Array.from(escrowBytes),
          blockNumber: "0x2",
          logIndex: "0x0",
        },
      ]),
    };

    const res = await queryContractLogsPaginated(
      client,
      { fromBlock: 1, toBlock: 2 },
      {
        decode: true,
        kind: (log) => {
          if (log.topics?.[0] === "htlc") return "htlc";
          if (log.topics?.[0] === "escrow") return "escrow";
          return null;
        },
      },
    );

    expect(res.logs).toHaveLength(3);
    expect(res.decodedLogs).toHaveLength(2);
    expect(res.decodedLogs[0]?.index).toBe(0);
    expect(res.decodedLogs[0]?.kind).toBe("htlc");
    if (res.decodedLogs[0]?.kind === "htlc") {
      expect(res.decodedLogs[0].record.amount).toBe(4242n);
      expect(res.decodedLogs[0].record.status).toBe("claimed");
    }
    expect(res.decodedLogs[1]?.index).toBe(2);
    expect(res.decodedLogs[1]?.kind).toBe("escrow");
    if (res.decodedLogs[1]?.kind === "escrow") {
      expect(res.decodedLogs[1].record.amount).toBe(9090n);
      expect(res.decodedLogs[1].record.status).toBe("released");
    }

    // Explicitly decode: false omits decodedLogs even if kind is supplied
    const rawOnly = await queryContractLogsPaginated(
      client,
      { fromBlock: 1, toBlock: 2 },
      { decode: false, kind: "htlc" },
    );
    expect(rawOnly.decodedLogs).toBeUndefined();
  });

  it("honors AbortSignal before start and mid-pagination between chunks", async () => {
    const preAborted = new AbortController();
    preAborted.abort();

    const getLogsPre = vi.fn(async () => []);
    await expect(
      queryContractLogsPaginated(
        { getLogs: getLogsPre },
        { fromBlock: 0, toBlock: 500 },
        { signal: preAborted.signal },
      ),
    ).rejects.toBeInstanceOf(KovanicaAbortError);
    expect(getLogsPre).not.toHaveBeenCalled();

    const midController = new AbortController();
    let calls = 0;
    const getLogsMid = vi.fn(async () => {
      calls += 1;
      if (calls === 2) {
        midController.abort();
      }
      return [];
    });

    await expect(
      queryContractLogsPaginated(
        { getLogs: getLogsMid },
        { fromBlock: 0, toBlock: 499 },
        { maxSpan: 100, signal: midController.signal },
      ),
    ).rejects.toBeInstanceOf(KovanicaAbortError);
    expect(calls).toBe(2);
  });

  it("validates invalid ranges, maxSpan, maxPages, pageLimit, cursor, decode, and client fail-closed before RPC I/O", async () => {
    const getLogs = vi.fn(async () => []);
    const client: PaginatedLogsClient = { getLogs };

    await expect(
      queryContractLogsPaginated(client, { fromBlock: 20n, toBlock: 10n }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      queryContractLogsPaginated(client, { fromBlock: -1n, toBlock: 10n }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      queryContractLogsPaginated(client, { fromBlock: 0, toBlock: 10 }, { maxSpan: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      queryContractLogsPaginated(client, { fromBlock: 0, toBlock: 10 }, { maxSpan: 1.5 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      queryContractLogsPaginated(client, { fromBlock: 0, toBlock: 10 }, { maxPages: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      queryContractLogsPaginated(client, { fromBlock: 0, toBlock: 10 }, { maxPages: -3 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      queryContractLogsPaginated(client, { fromBlock: 0, toBlock: 10 }, { pageLimit: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      queryContractLogsPaginated(client, { fromBlock: 0, toBlock: 10, cursor: "not-a-cursor" }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      queryContractLogsPaginated(client, { fromBlock: 0, toBlock: 10 }, { decode: true }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      queryContractLogsPaginated(
        client,
        { fromBlock: 0, toBlock: 10 },
        { decode: true, kind: "invalid_kind" as never },
      ),
    ).rejects.toBeInstanceOf(KovanicaDecodeError);
    await expect(
      queryContractLogsPaginated(
        client,
        { fromBlock: 0, toBlock: 10, address: "kvnc_invalid" },
      ),
    ).rejects.toThrow();
    await expect(
      queryContractLogsPaginated({} as PaginatedLogsClient, { fromBlock: 0, toBlock: 10 }),
    ).rejects.toBeInstanceOf(TypeError);

    expect(getLogs).not.toHaveBeenCalled();
  });
});
