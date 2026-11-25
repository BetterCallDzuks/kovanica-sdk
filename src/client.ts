/**
 * Main Kovanica client implementation.
 * Provides typed, read-only methods for interacting with a Kovanica JSON-RPC node.
 */

import {
  KovanicaAbortError,
  KovanicaRpcError,
  KovanicaTimeoutError,
  KovanicaTransportError,
} from "./errors";
import {
  FailoverHttpTransport,
  type FailoverHttpTransportOptions,
  HttpTransport,
  type HttpTransportOptions,
  type Transport,
  validateJsonRpcBatchRequests,
} from "./transport";
import type {
  BlockResponse,
  DagTips,
  JsonRpcBatchItemResult,
  JsonRpcBatchRequestItem,
  LeaderSlot,
  MiningInfo,
  RequestOptions,
  RpcRetryConfig,
  SyncPeerStatus,
  SyncStatus,
  TransactionKind,
  TransactionReceipt,
  TransactionReceiptLog,
  TransactionResponse,
  ValidatorInfo,
} from "./types";
import { parseQuantity, toHexQuantity } from "./units";

/** Canonical Balanced-tier fixed minimum fees in KVNC atoms (75% burn / 25% miner). */
export const FIXED_FEE_SCHEDULE = {
  deploy: 1_000_000_000n,
  token_create: 5_000_000_000n,
  nft_create_collection: 2_000_000_000n,
  nft_mint: 100_000_000n,
  rwa_create: 10_000_000_000n,
  rwa_mint: 500_000_000n,
} as const;

export interface BaseFeeInfo {
  baseFeePerByte: bigint;
  minBaseFeePerByte: bigint;
  maxBaseFeePerByte: bigint;
  targetBlockBytes: bigint;
  storageDepositPerByte: bigint;
  defaultGasPriceAtoms: bigint;
}

export interface StorageDepositInfo {
  contract: string;
  bytes: bigint;
  depositAtoms: bigint;
  depositPerByte: bigint;
}

export interface SessionKeyPolicyInfo {
  owner: string;
  sessionPubkey: string;
  allowedContracts: string[];
  allowedMethods: string[];
  maxSpendAtoms: bigint;
  spentAtoms: bigint;
  expiresRound: bigint;
  revoked: boolean;
}

export interface FeeSchedule {
  chainId: bigint;
  activeFromRound: bigint;
  active: boolean;
  feeSplitBurnBps: number;
  feeSplitMinerBps: number;
  fixedFees: {
    deploy: bigint;
    tokenCreate: bigint;
    nftCreateCollection: bigint;
    nftMint: bigint;
    rwaCreate: bigint;
    rwaMint: bigint;
  };
}
import {
  type BatchDryRunResult,
  type CallTxKind,
  type CallTxKindInput,
  type DryRunBatchCallItem,
  type DryRunBatchCallsOptions,
  type DryRunCallOptions,
  type DryRunCallResult,
  type EstimateAndBuildCallOptions,
  type EstimateBatchCallsOptions,
  type PreparedBatchCallTransactions,
  type PreparedCallTransaction,
  type SignedTxResult,
  type WaitForTransactionReceiptOptions,
  buildCallTxKind,
  dryRunBatchCalls,
  dryRunCall,
  estimateAndBuildCall,
  estimateBatchCalls,
  signCallContractTransaction,
  waitForTransactionReceipt,
} from "./contracts";
import {
  type ContractLogKind,
  type ContractStorageReadResult,
  type ContractStorageTarget,
  type DecodedContractLogByKind,
  type DefaultDecodedStorageByKind,
  type ReadContractStorageOptions,
  type StorageSlotKey,
  type StorageSlotKind,
  readContractStorage,
} from "./decoders";
import { getPublicKey } from "./wallet";
import { type MempoolFeeStats, parseMempoolFeeStats } from "./mempool-stats";

export type { RpcRetryConfig } from "./types";

/**
 * Read-only, idempotent JSON-RPC methods eligible for automatic retry and multi-endpoint failover
 * on transient transport, timeout, or HTTP 5xx errors.
 *
 * State-mutating methods such as `kovanica_sendRawTransaction` are intentionally excluded.
 */
export const DEFAULT_IDEMPOTENT_RPC_METHODS: ReadonlyArray<string> = Object.freeze([
  "kovanica_chainId",
  "kovanica_blockNumber",
  "kovanica_getBalance",
  "kovanica_getNonce",
  "kovanica_estimateFee",
  "kovanica_getFeeSchedule",
  "kovanica_getBaseFee",
  "kovanica_getStorageDeposit",
  "kovanica_getSessionKey",
  "kovanica_call",
  "kovanica_getStorageAt",
  "kovanica_getCode",
  "kovanica_getTransactionByHash",
  "kovanica_getTransactionReceipt",
  "kovanica_getTransactionHistory",
  "kovanica_getPendingTransactions",
  "kovanica_mempoolStats",
  "kovanica_getLogs",
  "kovanica_getBlockByHash",
  "kovanica_getBlockByNumber",
  "kovanica_getBlockByHeight",
  "kovanica_getNodeInfo",
  "kovanica_syncStatus",
  "kovanica_getMiningInfo",
  "kovanica_getDagTips",
  "kovanica_getValidators",
  "kovanica_getStake",
  "kovanica_getRewards",
  "kovanica_getLeaderSchedule",
]);

const DEFAULT_RETRY_INITIAL_DELAY_MS = 100;
const DEFAULT_RETRY_MAX_DELAY_MS = 5_000;
const DEFAULT_RETRY_JITTER_RATIO = 0.2;

/**
 * Computes a bounded, jittered exponential backoff delay in milliseconds for a 0-indexed
 * retry attempt (`attempt = 0` for the first retry).
 */
export function computeRetryDelayMs(
  attempt: number,
  options?: Pick<RpcRetryConfig, "initialDelayMs" | "maxDelayMs" | "jitterRatio">,
  randomFn: () => number = Math.random,
): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const initialDelayMs = Math.max(0, options?.initialDelayMs ?? DEFAULT_RETRY_INITIAL_DELAY_MS);
  const maxDelayMs = Math.max(initialDelayMs, options?.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS);
  const rawJitter = options?.jitterRatio ?? DEFAULT_RETRY_JITTER_RATIO;
  const jitterRatio = Number.isFinite(rawJitter) ? Math.min(1, Math.max(0, rawJitter)) : 0;

  if (initialDelayMs === 0 || maxDelayMs === 0) {
    return 0;
  }

  const exp = Math.min(safeAttempt, 30);
  const baseDelay = Math.min(maxDelayMs, initialDelayMs * Math.pow(2, exp));

  if (jitterRatio === 0) {
    return Math.round(baseDelay);
  }

  const rand = randomFn();
  const clampedRand = Number.isFinite(rand) ? Math.min(1, Math.max(0, rand)) : 0.5;
  const factor = 1 + (clampedRand * 2 - 1) * jitterRatio;
  const jittered = Math.min(maxDelayMs, Math.max(0, baseDelay * factor));
  return Math.round(jittered);
}

function isTransientRpcError(err: unknown): boolean {
  if (err instanceof KovanicaAbortError) {
    return false;
  }
  if (err instanceof KovanicaRpcError) {
    return false;
  }
  if (err instanceof KovanicaTimeoutError) {
    return true;
  }
  if (err instanceof KovanicaTransportError) {
    if (err.status !== undefined) {
      return (
        (err.status >= 500 && err.status < 600) ||
        err.status === 429 ||
        err.status === 408
      );
    }
    return true;
  }
  return false;
}

function sleepWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new KovanicaAbortError("Request was aborted during retry backoff"));
  }
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new KovanicaAbortError("Request was aborted during retry backoff"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function resolveRpcUrls(options: KovanicaClientOptions): string[] {
  const candidates: string[] = [];

  if (options.url !== undefined) {
    if (typeof options.url !== "string" || options.url.trim().length === 0) {
      throw new Error("KovanicaClient url must be a non-empty string");
    }
    candidates.push(options.url.trim());
  }

  if (options.rpcUrl !== undefined) {
    if (typeof options.rpcUrl !== "string" || options.rpcUrl.trim().length === 0) {
      throw new Error("KovanicaClient rpcUrl must be a non-empty string");
    }
    candidates.push(options.rpcUrl.trim());
  }

  if (options.rpcUrls !== undefined) {
    for (const entry of options.rpcUrls) {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        throw new Error("KovanicaClient rpcUrls entries must be non-empty strings");
      }
      candidates.push(entry.trim());
    }
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const url of candidates) {
    if (!seen.has(url)) {
      seen.add(url);
      deduped.push(url);
    }
  }

  if (deduped.length === 0) {
    throw new Error("KovanicaClient requires at least one valid RPC URL or a custom transport");
  }

  return deduped;
}

export interface KovanicaClientOptions extends Omit<HttpTransportOptions, "url"> {
  /** Primary JSON-RPC endpoint URL (e.g. "http://127.0.0.1:8545/rpc"). */
  url?: string;
  /** Alias for `url` (primary JSON-RPC endpoint URL). */
  rpcUrl?: string;
  /**
   * Ordered list of fallback RPC URLs. Primary `url`/`rpcUrl` is placed first if provided,
   * and the combined list is deduplicated in order. Fails closed if no valid URL is provided.
   */
  rpcUrls?: ReadonlyArray<string>;
  /**
   * Optional retry and exponential-backoff configuration for transient transport/timeout/5xx errors.
   * Defaults to `maxRetries = 0` for single-endpoint clients (opt-in).
   */
  retry?: RpcRetryConfig;
  /** Optional custom transport. If provided, `url`, `rpcUrl`, and `rpcUrls` are ignored. */
  transport?: Transport;
}

/** Alias for {@link KovanicaClientOptions}. */
export type KovanicaClientConfig = KovanicaClientOptions;

/**
 * Safely parse an optional quantity into a bigint.
 * - null or undefined -> undefined (preserves unavailable state; never turns into 0n)
 * - 0, "0", "0x0" -> 0n (preserves explicit zero)
 * - valid hex or decimal string / number / bigint -> parsed bigint
 * - boolean / object / invalid string -> undefined (wrong types are discarded rather than corrupting state)
 * - unsafe float numbers (> Number.MAX_SAFE_INTEGER) -> parseQuantity throws TypeError
 */
export function parseSafeOptionalQuantity(value: unknown): bigint | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "boolean" || typeof value === "object" || typeof value === "symbol") {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    if (!trimmed.startsWith("0x") && !trimmed.startsWith("0X") && !/^-?\d+$/.test(trimmed)) {
      return undefined;
    }
  }
  return parseQuantity(value);
}

/**
 * Evaluates whether a node is confirmed to be in sync based on its SyncStatus.
 *
 * In Kovanica L1, `catchingUp === false` alone is insufficient to claim a node is synced:
 * the node must also have a known local tip round and at least one connected peer.
 * If catchingUp is true, returns false (node is actively catching up).
 * If catchingUp is undefined, or peerCount is 0 / undefined, or localTipRound is undefined,
 * returns undefined (state is unknown/indeterminate).
 */
export function isNodeSynced(status: SyncStatus): boolean | undefined {
  if (status.catchingUp === true) {
    return false;
  }
  if (status.catchingUp === false) {
    if (
      status.localTipRound !== undefined &&
      status.peerCount !== undefined &&
      status.peerCount > 0
    ) {
      return true;
    }
    return undefined;
  }
  return undefined;
}

export class KovanicaClient {
  readonly transport: Transport;
  readonly rpcUrls: ReadonlyArray<string>;
  private readonly transports: ReadonlyArray<Transport>;
  private activeEndpointIndex = 0;
  private readonly maxRetries: number;
  private readonly retryBackoff: Pick<RpcRetryConfig, "initialDelayMs" | "maxDelayMs" | "jitterRatio">;
  private readonly retryableMethods: ReadonlySet<string>;

  constructor(optionsOrUrl: string | KovanicaClientOptions) {
    if (typeof optionsOrUrl === "string") {
      const httpTransport = new HttpTransport({ url: optionsOrUrl });
      this.transport = httpTransport;
      this.transports = [httpTransport];
      this.rpcUrls = Object.freeze([httpTransport.url]);
      this.maxRetries = 0;
      this.retryBackoff = {
        initialDelayMs: DEFAULT_RETRY_INITIAL_DELAY_MS,
        maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
        jitterRatio: DEFAULT_RETRY_JITTER_RATIO,
      };
      this.retryableMethods = new Set(DEFAULT_IDEMPOTENT_RPC_METHODS);
      return;
    }

    if (optionsOrUrl.transport) {
      this.transport = optionsOrUrl.transport;
      this.transports = [optionsOrUrl.transport];
      this.rpcUrls = Object.freeze([]);
    } else {
      const urls = resolveRpcUrls(optionsOrUrl);
      const {
        url: _url,
        rpcUrl: _rpcUrl,
        rpcUrls: _rpcUrls,
        retry: _retry,
        transport: _transport,
        ...httpBaseOptions
      } = optionsOrUrl;
      const builtTransports = urls.map(
        (endpointUrl) => new HttpTransport({ ...httpBaseOptions, url: endpointUrl }),
      );
      this.transports = builtTransports;
      this.transport = builtTransports[0]!;
      this.rpcUrls = Object.freeze(urls);
    }

    const retry = optionsOrUrl.retry;
    if (retry?.maxRetries !== undefined) {
      if (!Number.isInteger(retry.maxRetries) || retry.maxRetries < 0) {
        throw new RangeError("retry.maxRetries must be a non-negative integer");
      }
      this.maxRetries = retry.maxRetries;
    } else {
      this.maxRetries = this.transports.length > 1 ? this.transports.length - 1 : 0;
    }

    if (retry?.initialDelayMs !== undefined) {
      if (!Number.isFinite(retry.initialDelayMs) || retry.initialDelayMs < 0) {
        throw new RangeError("retry.initialDelayMs must be a non-negative finite number");
      }
    }
    if (retry?.maxDelayMs !== undefined) {
      if (!Number.isFinite(retry.maxDelayMs) || retry.maxDelayMs < 0) {
        throw new RangeError("retry.maxDelayMs must be a non-negative finite number");
      }
    }
    if (retry?.jitterRatio !== undefined) {
      if (!Number.isFinite(retry.jitterRatio) || retry.jitterRatio < 0 || retry.jitterRatio > 1) {
        throw new RangeError("retry.jitterRatio must be a finite number between 0 and 1");
      }
    }

    const defaultInitialDelay = retry === undefined && this.transports.length > 1
      ? 0
      : DEFAULT_RETRY_INITIAL_DELAY_MS;

    this.retryBackoff = {
      initialDelayMs: retry?.initialDelayMs ?? defaultInitialDelay,
      maxDelayMs: retry?.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
      jitterRatio: retry?.jitterRatio ?? DEFAULT_RETRY_JITTER_RATIO,
    };

    this.retryableMethods = new Set(retry?.retryableMethods ?? DEFAULT_IDEMPOTENT_RPC_METHODS);
  }

  /**
   * Generic low-level JSON-RPC call.
   * When retry or multi-endpoint failover is configured, transient transport/timeout/5xx errors
   * on allowlisted idempotent methods rotate to the next endpoint and retry with bounded jittered
   * exponential backoff.
   */
  async call<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<TResult> {
    const canRetryMethod = this.retryableMethods.has(method);
    const maxRetries = canRetryMethod ? this.maxRetries : 0;

    let attempt = 0;
    while (true) {
      if (options?.signal?.aborted) {
        throw new KovanicaAbortError("Request was already aborted");
      }

      const endpointIndex = this.activeEndpointIndex;
      const activeTransport = this.transports[endpointIndex]!;

      try {
        return await activeTransport.send<TResult>(method, params, options);
      } catch (err: unknown) {
        if (attempt >= maxRetries || !isTransientRpcError(err)) {
          throw err;
        }

        if (this.transports.length > 1) {
          this.activeEndpointIndex = (endpointIndex + 1) % this.transports.length;
        }

        const delayMs = computeRetryDelayMs(attempt, this.retryBackoff);
        attempt += 1;

        if (delayMs > 0) {
          await sleepWithAbort(delayMs, options?.signal);
        } else if (options?.signal?.aborted) {
          throw new KovanicaAbortError("Request was aborted during retry backoff");
        }
      }
    }
  }

  /**
   * Executes a bounded JSON-RPC 2.0 batch request (1..=32 items) in a single HTTP round-trip
   * when supported by the active transport, or falls back to parallel `transport.send` calls
   * for custom transports without `sendBatch`.
   *
   * Per-item JSON-RPC errors are isolated into `{ ok: false, error: KovanicaRpcError }` entries
   * rather than rejecting the entire batch.
   *
   * Automatic retry and multi-endpoint failover on transient transport/timeout/5xx errors are
   * enabled ONLY when EVERY method in the batch is allowlisted in `retryableMethods`
   * (batches containing `kovanica_sendRawTransaction` are never auto-retried by default).
   */
  async callBatch<TResult = unknown>(
    requests: ReadonlyArray<JsonRpcBatchRequestItem>,
    options?: RequestOptions,
  ): Promise<Array<JsonRpcBatchItemResult<TResult>>> {
    validateJsonRpcBatchRequests(requests);

    const canRetryBatch = requests.every((req) => this.retryableMethods.has(req.method));
    const maxRetries = canRetryBatch ? this.maxRetries : 0;

    let attempt = 0;
    while (true) {
      if (options?.signal?.aborted) {
        throw new KovanicaAbortError("Request was already aborted");
      }

      const endpointIndex = this.activeEndpointIndex;
      const activeTransport = this.transports[endpointIndex]!;

      try {
        if (typeof activeTransport.sendBatch === "function") {
          return await activeTransport.sendBatch<TResult>(requests, options);
        }
        return await Promise.all(
          requests.map(async (req): Promise<JsonRpcBatchItemResult<TResult>> => {
            try {
              const result = await activeTransport.send<TResult>(
                req.method,
                req.params,
                options,
              );
              return { ok: true, result };
            } catch (itemErr: unknown) {
              if (itemErr instanceof KovanicaRpcError) {
                return { ok: false, error: itemErr };
              }
              throw itemErr;
            }
          }),
        );
      } catch (err: unknown) {
        if (attempt >= maxRetries || !isTransientRpcError(err)) {
          throw err;
        }

        if (this.transports.length > 1) {
          this.activeEndpointIndex = (endpointIndex + 1) % this.transports.length;
        }

        const delayMs = computeRetryDelayMs(attempt, this.retryBackoff);
        attempt += 1;

        if (delayMs > 0) {
          await sleepWithAbort(delayMs, options?.signal);
        } else if (options?.signal?.aborted) {
          throw new KovanicaAbortError("Request was aborted during retry backoff");
        }
      }
    }
  }

  // ==========================================================================
  // Core Chain Methods
  // ==========================================================================

  /**
   * Returns the latest committed leader height as a `bigint`.
   * RPC: `kovanica_blockNumber`
   */
  async blockNumber(options?: RequestOptions): Promise<bigint> {
    const raw = await this.call<unknown>("kovanica_blockNumber", [], options);
    return parseQuantity(raw);
  }

  /**
   * Returns a block by its round/height number.
   * RPC: `kovanica_getBlockByNumber`
   */
  async getBlockByNumber(
    blockNumber: bigint | number | string,
    fullTransactions = false,
    options?: RequestOptions,
  ): Promise<BlockResponse | null> {
    const hex = typeof blockNumber === "string" && blockNumber.startsWith("0x")
      ? blockNumber
      : toHexQuantity(parseQuantity(blockNumber));

    const raw = await this.call<RawBlockResponse | null>(
      "kovanica_getBlockByNumber",
      [hex, fullTransactions],
      options,
    );
    if (!raw) return null;
    return mapBlockResponse(raw);
  }

  /**
   * Returns a block by its 32-byte digest/hash.
   * RPC: `kovanica_getBlockByHash`
   */
  async getBlockByHash(
    hash: string,
    fullTransactions = false,
    options?: RequestOptions,
  ): Promise<BlockResponse | null> {
    const normalized = hash.startsWith("0x") ? hash : `0x${hash}`;
    const raw = await this.call<RawBlockResponse | null>(
      "kovanica_getBlockByHash",
      [normalized, fullTransactions],
      options,
    );
    if (!raw) return null;
    return mapBlockResponse(raw);
  }

  // ==========================================================================
  // Account Methods
  // ==========================================================================

  /**
   * Returns the balance of an account in atomic units (atoms) as a `bigint`.
   * RPC: `kovanica_getBalance`
   */
  async getBalance(address: string, options?: RequestOptions): Promise<bigint> {
    const raw = await this.call<unknown>("kovanica_getBalance", [address], options);
    return parseQuantity(raw);
  }

  /**
   * Returns the transaction sequence nonce of an account as a `bigint`.
   * RPC: `kovanica_getNonce`
   */
  async getNonce(address: string, options?: RequestOptions): Promise<bigint> {
    const raw = await this.call<unknown>("kovanica_getNonce", [address], options);
    return parseQuantity(raw);
  }

  /**
   * Returns the compiled Wasm bytecode of a deployed contract as a hex string.
   * RPC: `kovanica_getCode`
   */
  async getCode(address: string, options?: RequestOptions): Promise<string> {
    return this.call<string>("kovanica_getCode", [address], options);
  }

  /**
   * Returns the value at a storage slot of an account.
   * RPC: `kovanica_getStorageAt`
   */
  async getStorageAt(
    address: string,
    slot: string | number | bigint,
    options?: RequestOptions,
  ): Promise<string> {
    const slotArg = typeof slot === "bigint" || typeof slot === "number"
      ? toHexQuantity(slot)
      : slot;
    return this.call<string>("kovanica_getStorageAt", [address, slotArg], options);
  }

  /**
   * Reads a contract storage slot via `kovanica_getStorageAt`, automatically deriving
   * canonical or prefixed BLAKE3 storage slots, detecting empty/zero slots, and optionally
   * decoding Bincode state records.
   */
  async readContractStorage<TDecoded>(
    contract: Uint8Array | string,
    target: {
      slotHex: string;
      decoder: (bytes: Uint8Array) => TDecoded;
    },
    options?: ReadContractStorageOptions,
  ): Promise<ContractStorageReadResult<TDecoded>>;
  async readContractStorage<K extends ContractLogKind>(
    contract: Uint8Array | string,
    target: {
      slotHex: string;
      decoder: K;
    },
    options?: ReadContractStorageOptions,
  ): Promise<ContractStorageReadResult<DecodedContractLogByKind<K>["record"]>>;
  async readContractStorage<TDecoded = undefined>(
    contract: Uint8Array | string,
    target: {
      slotHex: string;
      decoder?: undefined;
    },
    options?: ReadContractStorageOptions,
  ): Promise<ContractStorageReadResult<TDecoded>>;
  async readContractStorage<TDecoded>(
    contract: Uint8Array | string,
    target: {
      kind: StorageSlotKind;
      key?: StorageSlotKey;
      decoder: (bytes: Uint8Array) => TDecoded;
    },
    options?: ReadContractStorageOptions,
  ): Promise<ContractStorageReadResult<TDecoded>>;
  async readContractStorage<K extends ContractLogKind>(
    contract: Uint8Array | string,
    target: {
      kind: StorageSlotKind;
      key?: StorageSlotKey;
      decoder: K;
    },
    options?: ReadContractStorageOptions,
  ): Promise<ContractStorageReadResult<DecodedContractLogByKind<K>["record"]>>;
  async readContractStorage<S extends StorageSlotKind>(
    contract: Uint8Array | string,
    target: {
      kind: S;
      key?: StorageSlotKey;
      decoder?: undefined;
    },
    options?: ReadContractStorageOptions,
  ): Promise<ContractStorageReadResult<DefaultDecodedStorageByKind<S>>>;
  async readContractStorage<TDecoded>(
    contract: Uint8Array | string,
    target: {
      prefix: string | Uint8Array;
      key?: string | Uint8Array;
      decoder: (bytes: Uint8Array) => TDecoded;
    },
    options?: ReadContractStorageOptions,
  ): Promise<ContractStorageReadResult<TDecoded>>;
  async readContractStorage<K extends ContractLogKind>(
    contract: Uint8Array | string,
    target: {
      prefix: string | Uint8Array;
      key?: string | Uint8Array;
      decoder: K;
    },
    options?: ReadContractStorageOptions,
  ): Promise<ContractStorageReadResult<DecodedContractLogByKind<K>["record"]>>;
  async readContractStorage<TDecoded = undefined>(
    contract: Uint8Array | string,
    target: {
      prefix: string | Uint8Array;
      key?: string | Uint8Array;
      decoder?: undefined;
    },
    options?: ReadContractStorageOptions,
  ): Promise<ContractStorageReadResult<TDecoded>>;
  async readContractStorage<TDecoded = unknown>(
    contract: Uint8Array | string,
    target: ContractStorageTarget<TDecoded>,
    options?: ReadContractStorageOptions,
  ): Promise<ContractStorageReadResult<TDecoded>>;
  async readContractStorage<TDecoded = unknown>(
    contract: Uint8Array | string,
    target: ContractStorageTarget<TDecoded>,
    options?: ReadContractStorageOptions,
  ): Promise<ContractStorageReadResult<TDecoded>> {
    return readContractStorage<TDecoded>(this, contract, target, options);
  }

  // ==========================================================================
  // Transaction & Mempool Methods
  // ==========================================================================

  /**
   * Returns transaction details by transaction hash.
   * RPC: `kovanica_getTransactionByHash`
   */
  async getTransactionByHash(
    hash: string,
    options?: RequestOptions,
  ): Promise<TransactionResponse | null> {
    const normalized = hash.startsWith("0x") ? hash : `0x${hash}`;
    const raw = await this.call<RawTransactionResponse | null>(
      "kovanica_getTransactionByHash",
      [normalized],
      options,
    );
    if (!raw) return null;
    return mapTransactionResponse(raw);
  }

  /**
   * Returns the receipt of a mined/committed transaction.
   * RPC: `kovanica_getTransactionReceipt`
   */
  async getTransactionReceipt(
    hash: string,
    options?: RequestOptions,
  ): Promise<TransactionReceipt | null> {
    const normalized = hash.startsWith("0x") ? hash : `0x${hash}`;
    const raw = await this.call<RawTransactionReceipt | null>(
      "kovanica_getTransactionReceipt",
      [normalized],
      options,
    );
    if (!raw) return null;
    return {
      transactionHash: raw.transactionHash,
      blockHash: raw.blockHash,
      blockNumber: parseQuantity(raw.blockNumber),
      transactionIndex:
        raw.transactionIndex != null ? parseQuantity(raw.transactionIndex) : null,
      status: typeof raw.status === "number" ? raw.status : Number(parseQuantity(raw.status)),
      success: Boolean(raw.success),
      gasUsed: raw.gasUsed != null ? parseQuantity(raw.gasUsed) : undefined,
      ...(Array.isArray(raw.logs) ? { logs: raw.logs } : {}),
    };
  }

  /**
   * Polls `getTransactionReceipt(txHash)` until a non-null receipt is returned
   * or `options.timeoutMs` elapses.
   */
  async waitForTransactionReceipt(
    txHash: string,
    options?: WaitForTransactionReceiptOptions,
  ): Promise<TransactionReceipt> {
    return waitForTransactionReceipt(this, txHash, options);
  }

  /**
   * Returns hashes of transactions currently pending in the mempool.
   * RPC: `kovanica_getPendingTransactions`
   */
  async getPendingTransactions(options?: RequestOptions): Promise<string[]> {
    return this.call<string[]>("kovanica_getPendingTransactions", [], options);
  }

  /**
   * Returns the suggested minimum gas fee rate in atoms per byte.
   * RPC: `kovanica_estimateFee`
   */
  async estimateFee(options?: RequestOptions): Promise<bigint> {
    const raw = await this.call<unknown>("kovanica_estimateFee", [], options);
    return parseQuantity(raw);
  }

  /**
   * Returns the canonical fixed operation fee floors, fee split, and activation status.
   * RPC: `kovanica_getFeeSchedule`
   */
  async getFeeSchedule(options?: RequestOptions): Promise<FeeSchedule> {
    const raw = await this.call<Record<string, unknown>>("kovanica_getFeeSchedule", [], options);
    const fees = (raw.fixed_fees ?? {}) as Record<string, unknown>;
    return {
      chainId: parseQuantity(raw.chain_id),
      activeFromRound: parseQuantity(raw.active_from_round),
      active: Boolean(raw.active),
      feeSplitBurnBps: Number(raw.fee_split_burn_bps ?? 7500),
      feeSplitMinerBps: Number(raw.fee_split_miner_bps ?? 2500),
      fixedFees: {
        deploy: parseQuantity(fees.deploy ?? FIXED_FEE_SCHEDULE.deploy),
        tokenCreate: parseQuantity(fees.token_create ?? FIXED_FEE_SCHEDULE.token_create),
        nftCreateCollection: parseQuantity(
          fees.nft_create_collection ?? FIXED_FEE_SCHEDULE.nft_create_collection,
        ),
        nftMint: parseQuantity(fees.nft_mint ?? FIXED_FEE_SCHEDULE.nft_mint),
        rwaCreate: parseQuantity(fees.rwa_create ?? FIXED_FEE_SCHEDULE.rwa_create),
        rwaMint: parseQuantity(fees.rwa_mint ?? FIXED_FEE_SCHEDULE.rwa_mint),
      },
    };
  }

  /**
   * Returns current EIP-1559 dynamic base fee per byte and storage deposit parameters.
   * RPC: `kovanica_getBaseFee`
   */
  async getBaseFee(options?: RequestOptions): Promise<BaseFeeInfo> {
    const raw = await this.call<Record<string, unknown>>("kovanica_getBaseFee", [], options);
    return {
      baseFeePerByte: parseQuantity(raw.base_fee_per_byte),
      minBaseFeePerByte: parseQuantity(raw.min_base_fee_per_byte),
      maxBaseFeePerByte: parseQuantity(raw.max_base_fee_per_byte),
      targetBlockBytes: parseQuantity(raw.target_block_bytes),
      storageDepositPerByte: parseQuantity(raw.storage_deposit_per_byte),
      defaultGasPriceAtoms: parseQuantity(raw.default_gas_price_atoms),
    };
  }

  /**
   * Returns refundable storage deposit accounting for a contract address.
   * RPC: `kovanica_getStorageDeposit`
   */
  async getStorageDeposit(
    contract: string,
    options?: RequestOptions,
  ): Promise<StorageDepositInfo> {
    const raw = await this.call<Record<string, unknown>>(
      "kovanica_getStorageDeposit",
      [contract],
      options,
    );
    return {
      contract: String(raw.contract ?? contract),
      bytes: parseQuantity(raw.bytes),
      depositAtoms: parseQuantity(raw.deposit_atoms),
      depositPerByte: parseQuantity(raw.deposit_per_byte),
    };
  }

  /**
   * Looks up a persisted scoped session key policy for `(owner, sessionPubkeyHex)`.
   * Returns `null` if absent or revoked.
   * RPC: `kovanica_getSessionKey`
   */
  async getSessionKey(
    owner: string,
    sessionPubkeyHex: string,
    options?: RequestOptions,
  ): Promise<SessionKeyPolicyInfo | null> {
    const raw = await this.call<Record<string, unknown> | null>(
      "kovanica_getSessionKey",
      [owner, sessionPubkeyHex],
      options,
    );
    if (!raw) return null;
    return {
      owner: String(raw.owner ?? owner),
      sessionPubkey: String(raw.session_pubkey ?? sessionPubkeyHex),
      allowedContracts: Array.isArray(raw.allowed_contracts)
        ? raw.allowed_contracts.map(String)
        : [],
      allowedMethods: Array.isArray(raw.allowed_methods)
        ? raw.allowed_methods.map(String)
        : [],
      maxSpendAtoms: parseQuantity(raw.max_spend_atoms),
      spentAtoms: parseQuantity(raw.spent_atoms),
      expiresRound: parseQuantity(raw.expires_round),
      revoked: Boolean(raw.revoked),
    };
  }

  /**
   * Returns live mempool occupancy and fee-per-byte distribution statistics.
   * RPC: `kovanica_mempoolStats`
   */
  async getMempoolStats(options?: RequestOptions): Promise<MempoolFeeStats> {
    const raw = await this.call<unknown>("kovanica_mempoolStats", [], options);
    return parseMempoolFeeStats(raw);
  }

  /**
   * Submits a serialized, signed raw transaction hex to the mempool.
   * RPC: `kovanica_sendRawTransaction`
   */
  async sendRawTransaction(rawHex: string, options?: RequestOptions): Promise<string> {
    const normalized = rawHex.startsWith("0x") ? rawHex : `0x${rawHex}`;
    return this.call<string>("kovanica_sendRawTransaction", [normalized], options);
  }

  /**
   * Constructs a validated CallTxKind with default gas limits.
   */
  buildCallTransaction(call: CallTxKindInput): CallTxKind {
    return buildCallTxKind(call);
  }

  /**
   * Estimates fee/gas parameters for a contract call and builds a validated,
   * ready-to-sign call transaction payload with configurable safety margins.
   */
  async estimateAndBuildCall(
    call: CallTxKind | CallTxKindInput,
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    return estimateAndBuildCall(this, call, options);
  }

  /**
   * Estimates fee/gas parameters for a non-empty batch of contract calls in a single
   * parallel RPC round-trip and builds sequential-nonce ready-to-sign call payloads.
   */
  async estimateBatchCalls(
    calls: ReadonlyArray<CallTxKind | CallTxKindInput>,
    options?: EstimateBatchCallsOptions,
  ): Promise<PreparedBatchCallTransactions> {
    return estimateBatchCalls(this, calls, options);
  }

  /**
   * Simulates a read-only contract call against current node state via `kovanica_call`,
   * optionally decoding the returned bytes with a typed Bincode decoder.
   */
  async dryRunCall<TDecoded>(
    call: CallTxKind | CallTxKindInput,
    options: DryRunCallOptions<TDecoded> & { decoder: (bytes: Uint8Array) => TDecoded },
  ): Promise<DryRunCallResult<TDecoded> & { decoded: TDecoded }>;
  async dryRunCall<TDecoded = undefined>(
    call: CallTxKind | CallTxKindInput,
    options?: DryRunCallOptions<TDecoded>,
  ): Promise<DryRunCallResult<TDecoded>>;
  async dryRunCall<TDecoded = undefined>(
    call: CallTxKind | CallTxKindInput,
    options?: DryRunCallOptions<TDecoded>,
  ): Promise<DryRunCallResult<TDecoded>> {
    return dryRunCall(this, call, options);
  }

  /**
   * Simulates a non-empty batch of read-only contract calls via `dryRunCall`,
   * validating all inputs fail-closed before RPC I/O and returning aggregate batch counts.
   */
  async dryRunBatchCalls<TDecoded = unknown>(
    calls: ReadonlyArray<DryRunBatchCallItem<TDecoded>>,
    options?: DryRunBatchCallsOptions,
  ): Promise<BatchDryRunResult<TDecoded>> {
    return dryRunBatchCalls(this, calls, options);
  }

  /**
   * Constructs and signs a Call contract transaction for a sender.
   */
  signCallTransaction(
    senderSecretKey: Uint8Array,
    call: CallTxKind | CallTxKindInput,
    options: {
      nonce: bigint | number;
      fee: bigint | number;
      sender?: Uint8Array | string;
      chainId?: number;
    },
  ): SignedTxResult {
    const sender = options.sender ?? getPublicKey(senderSecretKey);
    return signCallContractTransaction({
      sender,
      secretKey: senderSecretKey,
      call,
      nonce: options.nonce,
      fee: options.fee,
      chainId: options.chainId,
    });
  }

  // ==========================================================================
  // Staking & Validator Methods
  // ==========================================================================

  /**
   * Returns the current validator set and their stake amounts.
   * RPC: `kovanica_getValidators`
   *
   * @deprecated Obsolete on Hybrid PoW + GHOSTDAG networks (chains 1 & 2), where
   * block authors are selected by PoW mining. Calling this method returns -32600.
   * Use {@link getDagTips} and {@link getBlockByHash} instead.
   */
  async getValidators(options?: RequestOptions): Promise<ValidatorInfo[]> {
    const raw = await this.call<RawValidatorInfo[]>("kovanica_getValidators", [], options);
    return (raw || []).map((v) => ({
      address: v.address,
      stake: parseQuantity(v.stake),
      commission_bps: v.commission_bps,
      active: v.active,
      payout_address: v.payout_address,
    }));
  }

  /**
   * Returns the bonded stake for a given address.
   * RPC: `kovanica_getStake`
   *
   * @deprecated Stake is not used for consensus on Hybrid PoW + GHOSTDAG networks
   * (chains 1 & 2). Calling this method returns -32600.
   * Use {@link getBalance} for spendable balance and {@link getMiningInfo} for PoW state.
   */
  async getStake(address: string, options?: RequestOptions): Promise<bigint> {
    const raw = await this.call<unknown>("kovanica_getStake", [address], options);
    return parseQuantity(raw);
  }

  /**
   * Returns cumulative earned rewards for a given address.
   * RPC: `kovanica_getRewards`
   *
   * @deprecated Legacy staking rewards are obsolete on Hybrid networks (chains 1 & 2).
   * Miners receive PoW block rewards directly in executed blocks. Calling this returns -32600.
   * Use {@link getBalance} instead.
   */
  async getRewards(address: string, options?: RequestOptions): Promise<bigint> {
    const raw = await this.call<unknown>("kovanica_getRewards", [address], options);
    return parseQuantity(raw);
  }

  /**
   * Returns the upcoming leader schedule.
   * RPC: `kovanica_getLeaderSchedule`
   *
   * @deprecated Obsolete on Hybrid PoW + GHOSTDAG networks (chains 1 & 2) where
   * there is no round-robin committee. Calling this returns -32600.
   * Use {@link getDagTips} to inspect upcoming and active DAG frontier tips.
   */
  async getLeaderSchedule(count = 16, options?: RequestOptions): Promise<LeaderSlot[]> {
    const raw = await this.call<RawLeaderSlot[]>(
      "kovanica_getLeaderSchedule",
      [count],
      options,
    );
    return (raw || []).map((slot) => ({
      round: parseQuantity(slot.round),
      leaderIndex: (slot.leaderIndex ?? slot.leader_index)!,
      leaderAddress: (slot.leaderAddress ?? slot.leader_address)!,
    }));
  }

  // ==========================================================================
  // Node Diagnostics & Hybrid PoW + GHOSTDAG (Chains 1 & 2) Methods
  // ==========================================================================

  /**
   * Returns node synchronization, catch-up and peer health status.
   * RPC: `kovanica_syncStatus`
   */
  async syncStatus(options?: RequestOptions): Promise<SyncStatus> {
    const raw = await this.call<RawSyncStatus>("kovanica_syncStatus", [], options);
    if (!raw || typeof raw !== "object") {
      throw new TypeError("Invalid syncStatus response: expected an object");
    }

    const localTipRound = parseSafeOptionalQuantity(raw.localTipRound ?? raw.local_tip_round);

    const rawCommitted =
      raw.committedHeight !== undefined && raw.committedHeight !== null
        ? raw.committedHeight
        : raw.committed_height !== undefined && raw.committed_height !== null
          ? raw.committed_height
          : raw.localHeight !== undefined && raw.localHeight !== null
            ? raw.localHeight
            : raw.local_height;
    const committedHeight = parseSafeOptionalQuantity(rawCommitted);

    const rawLocalHeight =
      raw.localHeight !== undefined && raw.localHeight !== null
        ? raw.localHeight
        : raw.local_height !== undefined && raw.local_height !== null
          ? raw.local_height
          : raw.committedHeight !== undefined && raw.committedHeight !== null
            ? raw.committedHeight
            : raw.committed_height;
    const localHeight = parseSafeOptionalQuantity(rawLocalHeight);

    let catchingUp: boolean | undefined;
    if (typeof raw.catchingUp === "boolean") {
      catchingUp = raw.catchingUp;
    } else if (typeof raw.catching_up === "boolean") {
      catchingUp = raw.catching_up;
    } else {
      catchingUp = undefined;
    }

    const catchUpTarget = parseSafeOptionalQuantity(raw.catchUpTarget ?? raw.catch_up_target);
    const behindBy = parseSafeOptionalQuantity(raw.behindBy ?? raw.behind_by);

    let peerCount: number | undefined;
    const rawCount =
      raw.peerCount !== undefined && raw.peerCount !== null ? raw.peerCount : raw.peer_count;
    if (typeof rawCount === "number" && Number.isSafeInteger(rawCount) && rawCount >= 0) {
      peerCount = rawCount;
    } else if (typeof rawCount === "string" && /^\d+$/.test(rawCount.trim())) {
      const n = Number(rawCount.trim());
      if (Number.isSafeInteger(n) && n >= 0) {
        peerCount = n;
      }
    } else if (
      typeof rawCount === "bigint" &&
      rawCount >= 0n &&
      rawCount <= BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      peerCount = Number(rawCount);
    } else {
      peerCount = undefined;
    }

    const peers: SyncPeerStatus[] = [];
    if (Array.isArray(raw.peers)) {
      for (const item of raw.peers) {
        if (item && typeof item === "object") {
          const rawPeerId = item.peerId ?? item.peer_id ?? item.addr;
          if (typeof rawPeerId === "string" && rawPeerId.trim().length > 0) {
            const peerId = rawPeerId.trim();
            const rawTip =
              item.reportedTipRound !== undefined && item.reportedTipRound !== null
                ? item.reportedTipRound
                : item.reported_tip_round !== undefined && item.reported_tip_round !== null
                  ? item.reported_tip_round
                  : item.tip_round;
            const reportedTipRound = parseSafeOptionalQuantity(rawTip);
            peers.push({
              peerId,
              reportedTipRound,
              peer_id: peerId,
              reported_tip_round: reportedTipRound,
              addr: peerId,
              tip_round: reportedTipRound,
            });
          }
        }
      }
    }

    const rawTag = raw.networkTag ?? raw.network_tag;
    const networkTag =
      typeof rawTag === "string" && rawTag.trim().length > 0 ? rawTag.trim() : undefined;

    return {
      localTipRound,
      committedHeight,
      localHeight,
      catchingUp,
      catchUpTarget,
      behindBy,
      peerCount,
      peers,
      networkTag,

      local_tip_round: localTipRound,
      committed_height: committedHeight,
      local_height: localHeight,
      catching_up: catchingUp,
      catch_up_target: catchUpTarget,
      behind_by: behindBy,
      peer_count: peerCount,
      network_tag: networkTag,
    };
  }

  /**
   * Returns PoW mining metrics, difficulty, and DAA targets (Hybrid PoW + GHOSTDAG: Mainnet Chain 1 and Testnet Chain 2).
   * RPC: `kovanica_getMiningInfo`
   */
  async getMiningInfo(options?: RequestOptions): Promise<MiningInfo> {
    const raw = await this.call<RawMiningInfo>("kovanica_getMiningInfo", [], options);
    return {
      chain_id: raw.chain_id,
      mining_enabled: Boolean(raw.mining_enabled),
      mining_threads: raw.mining_threads,
      target_bits: raw.target_bits,
      target: raw.target,
      difficulty: parseQuantity(raw.difficulty),
      target_block_time_ms: raw.target_block_time_ms,
      ghostdag_k: raw.ghostdag_k,
      network_hashrate_estimate: parseQuantity(raw.network_hashrate_estimate),
      dag_tips_count: raw.dag_tips_count,
    };
  }

  /**
   * Returns current active DAG tip block hashes (Hybrid PoW + GHOSTDAG: Mainnet Chain 1 and Testnet Chain 2).
   * RPC: `kovanica_getDagTips`
   */
  async getDagTips(options?: RequestOptions): Promise<DagTips> {
    const raw = await this.call<RawDagTips>("kovanica_getDagTips", [], options);
    return {
      chain_id: raw.chain_id,
      tips: raw.tips || [],
      count: raw.count,
      max_round: parseQuantity(raw.max_round),
      ghostdag_k: raw.ghostdag_k,
    };
  }
}

// ============================================================================
// Internal Raw JSON Deserialization Interfaces & Mappers
// ============================================================================

interface RawBlockResponse {
  hash: string;
  digest: string;
  author: number;
  number: string | number;
  round: string | number;
  parents: string[];
  transactions: Array<RawTransactionResponse | string>;
  statements: string;
  signature: string;
}

interface RawTransactionResponse {
  hash: string;
  sender: string;
  nonce: string | number;
  fee: string | number;
  kind: RawTransactionKind;
  signature: string;
}

type RawTransactionKind =
  | { type: "transfer"; to: string; amount: string | number }
  | { type: "stake"; amount: string | number }
  | { type: "unstake"; amount: string | number }
  | { type: "delegate"; validator: string; amount: string | number }
  | { type: "claim_rewards"; validator: string | null }
  | { type: "deploy"; code: string }
  | {
      type: "call";
      contract: string;
      value: number;
      method: string;
      args: string;
      gas_limit: string | number;
    }
  | { type: "register_light_node"; vrfPublicKey: string; stake: string | number }
  | { type: "exit_light_node" }
  | {
      type: "submit_light_witness";
      epoch: string | number;
      vrfHash: string;
      vrfProof: string;
    }
  | { type: "set_commission"; validator: string; commission_bps: string | number }
  | { type: "claim_treasury"; amount: string | number }
  | {
      type: "evidence";
      author: string;
      round: string | number;
      digest_a: string;
      digest_b: string;
    };

interface RawTransactionReceipt {
  transactionHash: string;
  blockHash: string;
  blockNumber: string | number;
  transactionIndex: string | number | null;
  status: string | number;
  success: boolean;
  gasUsed?: string | number;
  logs?: ReadonlyArray<TransactionReceiptLog>;
}

interface RawValidatorInfo {
  address: string;
  stake: string | number;
  commission_bps: number;
  active: boolean;
  payout_address: string;
}

interface RawLeaderSlot {
  round: string | number;
  leader_index?: number;
  leaderIndex?: number;
  leader_address?: string;
  leaderAddress?: string;
}

interface RawSyncPeerStatus {
  peerId?: string;
  peer_id?: string;
  reportedTipRound?: string | number | bigint;
  reported_tip_round?: string | number | bigint;
  addr?: string;
  tip_round?: string | number | bigint;
  latency_ms?: number;
  connected_secs?: number;
}

interface RawSyncStatus {
  localTipRound?: string | number | bigint;
  local_tip_round?: string | number | bigint;
  committedHeight?: string | number | bigint;
  committed_height?: string | number | bigint;
  localHeight?: string | number | bigint;
  local_height?: string | number | bigint;
  catchingUp?: boolean | null;
  catching_up?: boolean | null;
  catchUpTarget?: string | number | bigint;
  catch_up_target?: string | number | bigint;
  behindBy?: string | number | bigint;
  behind_by?: string | number | bigint;
  peerCount?: number | string | bigint | null;
  peer_count?: number | string | bigint | null;
  peers?: RawSyncPeerStatus[] | null;
  networkTag?: string | null;
  network_tag?: string | null;
}

interface RawMiningInfo {
  chain_id: number;
  mining_enabled: boolean;
  mining_threads: number;
  target_bits: string;
  target: string;
  difficulty: string | number;
  target_block_time_ms: number;
  ghostdag_k: number;
  network_hashrate_estimate: string | number;
  dag_tips_count: number;
}

interface RawDagTips {
  chain_id: number;
  tips: string[];
  count: number;
  max_round: string | number;
  ghostdag_k: number;
}

function mapTransactionKind(raw: RawTransactionKind): TransactionKind {
  switch (raw.type) {
    case "transfer":
      return { type: "transfer", to: raw.to, amount: parseQuantity(raw.amount) };
    case "stake":
      return { type: "stake", amount: parseQuantity(raw.amount) };
    case "unstake":
      return { type: "unstake", amount: parseQuantity(raw.amount) };
    case "delegate":
      return { type: "delegate", validator: raw.validator, amount: parseQuantity(raw.amount) };
    case "claim_rewards":
      return { type: "claim_rewards", validator: raw.validator };
    case "deploy":
      return { type: "deploy", code: raw.code };
    case "call":
      return {
        type: "call",
        contract: raw.contract,
        value: raw.value,
        method: raw.method,
        args: raw.args,
        gas_limit: parseQuantity(raw.gas_limit),
      };
    case "register_light_node":
      return {
        type: "register_light_node",
        vrfPublicKey: raw.vrfPublicKey,
        stake: parseQuantity(raw.stake),
      };
    case "exit_light_node":
      return { type: "exit_light_node" };
    case "submit_light_witness":
      return {
        type: "submit_light_witness",
        epoch: parseQuantity(raw.epoch),
        vrfHash: raw.vrfHash,
        vrfProof: raw.vrfProof,
      };
    case "set_commission":
      return {
        type: "set_commission",
        validator: raw.validator,
        commission_bps: parseQuantity(raw.commission_bps),
      };
    case "claim_treasury":
      return { type: "claim_treasury", amount: parseQuantity(raw.amount) };
    case "evidence":
      return {
        type: "evidence",
        author: raw.author,
        round: parseQuantity(raw.round),
        digest_a: raw.digest_a,
        digest_b: raw.digest_b,
      };
  }
}

function mapTransactionResponse(raw: RawTransactionResponse): TransactionResponse {
  return {
    hash: raw.hash,
    sender: raw.sender,
    nonce: parseQuantity(raw.nonce),
    fee: parseQuantity(raw.fee),
    kind: mapTransactionKind(raw.kind),
    signature: raw.signature,
  };
}

function mapBlockResponse(raw: RawBlockResponse): BlockResponse {
  return {
    hash: raw.hash,
    digest: raw.digest,
    author: raw.author,
    number: parseQuantity(raw.number),
    round: parseQuantity(raw.round),
    parents: raw.parents || [],
    transactions: (raw.transactions || []).map((tx) =>
      typeof tx === "string" ? tx : mapTransactionResponse(tx),
    ),
    statements: raw.statements,
    signature: raw.signature,
  };
}

/**
 * Creates a `KovanicaClient` backed by a multi-endpoint `FailoverHttpTransport`.
 */
export function createFailoverClient(
  urls: readonly string[],
  options?: Omit<FailoverHttpTransportOptions, "urls"> & { retry?: RpcRetryConfig },
): KovanicaClient {
  const { retry, ...transportOptions } = options ?? {};
  const transport = new FailoverHttpTransport({ ...transportOptions, urls });
  return new KovanicaClient({ transport, retry });
}
