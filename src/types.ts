/**
 * Kovanica JSON-RPC request and response schemas.
 * Verified against crates/kovanica-rpc in kovanica git SHA: d2239fd8314a0c6edb08d54724738d662d406a32
 */

import type { KovanicaRpcError } from "./errors";

/** Canonical 64-character PRO-21 Kovanica address (`kvnc...dag` / `tknc...dag`). */
export type KovanicaAddress = string;

/** Hexadecimal string (e.g. `"0x..."`). */
export type HexString = string;

export interface RequestOptions {
  /** Optional cancellation signal. */
  signal?: AbortSignal;
  /** Timeout in milliseconds for this specific request. Overrides transport default. */
  timeoutMs?: number;
}

/**
 * Optional retry & exponential-backoff configuration for transient RPC transport failures.
 */
export interface RpcRetryConfig {
  /**
   * Maximum number of retry attempts after the initial call fails.
   * Defaults to `0` for single-endpoint clients (opt-in) so existing tests remain deterministic.
   * When multiple `rpcUrls` are configured and `maxRetries` is omitted, defaults to
   * `rpcUrls.length - 1` to enable automatic failover across fallback endpoints.
   */
  maxRetries?: number;
  /**
   * Base backoff delay in milliseconds before the first retry (attempt 0).
   * Defaults to `100` ms when `retry` is configured (or `0` ms for implicit multi-endpoint failover).
   */
  initialDelayMs?: number;
  /**
   * Upper bound in milliseconds for exponential backoff delay.
   * Defaults to `5_000` ms.
   */
  maxDelayMs?: number;
  /**
   * Jitter ratio in `[0, 1]` applied to the exponential backoff delay.
   * At ratio `r`, delay is scaled by a random factor in `[1 - r, 1 + r]` (clamped to `[0, maxDelayMs]`).
   * Defaults to `0.2`.
   */
  jitterRatio?: number;
  /**
   * Explicit allowlist of JSON-RPC method names eligible for automatic retry/failover.
   * Defaults to `DEFAULT_IDEMPOTENT_RPC_METHODS` (read-only idempotent methods only;
   * never includes state-mutating `kovanica_sendRawTransaction` unless explicitly listed).
   */
  retryableMethods?: ReadonlyArray<string>;
}

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: TParams;
  id: string | number;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<TResult = unknown> {
  jsonrpc: "2.0";
  result?: TResult;
  error?: JsonRpcErrorObject;
  id: string | number | null;
}

export interface JsonRpcBatchRequestItem<TParams = unknown> {
  method: string;
  params?: TParams;
}

export type JsonRpcBatchItemResult<TResult = unknown> =
  | { ok: true; result: TResult }
  | { ok: false; error: KovanicaRpcError };

export type TransactionKind =
  | { type: "transfer"; to: string; amount: bigint }
  | { type: "stake"; amount: bigint }
  | { type: "unstake"; amount: bigint }
  | { type: "delegate"; validator: string; amount: bigint }
  | { type: "claim_rewards"; validator: string | null }
  | { type: "deploy"; code: string }
  | {
      type: "call";
      contract: string;
      value: number;
      method: string;
      args: string;
      gas_limit: bigint;
    }
  | { type: "register_light_node"; vrfPublicKey: string; stake: bigint }
  | { type: "exit_light_node" }
  | {
      type: "submit_light_witness";
      epoch: bigint;
      vrfHash: string;
      vrfProof: string;
    }
  | { type: "set_commission"; validator: string; commission_bps: bigint }
  | { type: "claim_treasury"; amount: bigint }
  | {
      type: "evidence";
      author: string;
      round: bigint;
      digest_a: string;
      digest_b: string;
    };

export interface TransactionResponse {
  hash: string;
  sender: string;
  nonce: bigint;
  fee: bigint;
  kind: TransactionKind;
  signature: string;
}

export interface BlockResponse {
  hash: string;
  digest: string;
  author: number;
  number: bigint;
  round: bigint;
  parents: string[];
  transactions: Array<TransactionResponse | string>;
  statements: string;
  signature: string;
}

export interface TransactionReceiptLog {
  address?: string;
  topics?: ReadonlyArray<string>;
  data: string;
}

export interface TransactionReceipt {
  transactionHash: string;
  blockHash: string;
  blockNumber: bigint;
  transactionIndex: bigint | null;
  status: number;
  success: boolean;
  gasUsed?: bigint;
  logs?: ReadonlyArray<TransactionReceiptLog>;
}

export interface ValidatorInfo {
  address: string;
  stake: bigint;
  commission_bps: number;
  active: boolean;
  payout_address: string;
}

export interface LeaderSlot {
  round: bigint;
  leaderIndex: number;
  leaderAddress: string;
}

export interface SyncPeerStatus {
  /** libp2p peer id (transport identity, not the validator key). */
  peerId: string;
  /** Last DAG tip round the peer reported, if it has answered a probe. */
  reportedTipRound?: bigint;

  // Backwards-compatible aliases:
  /** @deprecated Snake-case alias for peerId */
  peer_id?: string;
  /** @deprecated Snake-case alias for reportedTipRound */
  reported_tip_round?: bigint;
  /** @deprecated Legacy alias */
  addr?: string;
  /** @deprecated Legacy alias */
  tip_round?: bigint;
}

export interface SyncStatus {
  /** Local DAG tip round (`max_dag_round`); undefined if storage cannot be read. */
  localTipRound?: bigint;
  /** Latest committed leader height, when available. */
  committedHeight?: bigint;
  /** Local committed height (alias for committedHeight). */
  localHeight?: bigint;
  /**
   * Whether the node is actively pulling a peer's rounds.
   * `undefined` if unknown or unpopulated by node.
   */
  catchingUp?: boolean;
  /** Highest peer-advertised tip round being chased, when catching up. */
  catchUpTarget?: bigint;
  /** How many rounds behind the catch-up target the local tip is. */
  behindBy?: bigint;
  /** Number of connected peers; undefined if not reported. */
  peerCount?: number;
  /** Connected peers, bounded by the node's max_peers. */
  peers: SyncPeerStatus[];
  /** `<chain_id>-<first 16 hex chars of the genesis digest>`. */
  networkTag?: string;

  // Backwards-compatible aliases:
  /** @deprecated Use localTipRound */
  local_tip_round?: bigint;
  /** @deprecated Use committedHeight */
  committed_height?: bigint;
  /** @deprecated Use localHeight */
  local_height?: bigint;
  /** @deprecated Use catchingUp */
  catching_up?: boolean;
  /** @deprecated Use catchUpTarget */
  catch_up_target?: bigint;
  /** @deprecated Use behindBy */
  behind_by?: bigint;
  /** @deprecated Use peerCount */
  peer_count?: number;
  /** @deprecated Use networkTag */
  network_tag?: string;
}

export interface MiningInfo {
  chain_id: number;
  mining_enabled: boolean;
  mining_threads: number;
  target_bits: string;
  target: string;
  difficulty: bigint;
  target_block_time_ms: number;
  ghostdag_k: number;
  network_hashrate_estimate: bigint;
  dag_tips_count: number;
}

export interface DagTips {
  chain_id: number;
  tips: string[];
  count: number;
  max_round: bigint;
  ghostdag_k: number;
}
