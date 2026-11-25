/**
 * Native AMM / DEX Client (`AmmClient`) for Kovanica Protocol (`kovanica-amm`).
 *
 * Provides:
 * - Deterministic pool ID derivation (`blake3("kvnc/v1/amm/pool" || token0 || token1)`)
 * - Typed Bincode argument encoders and response decoders for all `kovanica-amm` methods
 * - Constant-product (`x * y = k`, 0.30% LP fee) quote, price impact, and slippage helpers
 * - 1-tx Atomic Wave A `Batch` builders (`approve + swap_exact_in`, `approve + add_liquidity`)
 */

import { blake3 } from "@noble/hashes/blake3.js";
import { encodeAddress } from "./address";
import {
  type CallTxKindInput,
  DEFAULT_CALL_GAS_LIMIT,
  type EstimateAndBuildCallOptions,
  type PreparedCallTransaction,
  bytesToHex,
  concatBytes,
  estimateAndBuildCall,
  hexToBytes,
  parseContractAddress,
  u128le,
} from "./contracts";
import { ContractFacade, type ContractFacadeClient } from "./facades";
import type { KovanicaAddress } from "./types";
import { type BatchAction, signBatchTransaction } from "./wave-a";

/** Sentinel 32-byte token address representing native KVNC. */
export const NATIVE_KVNC_TOKEN = new Uint8Array(32);
export const NATIVE_KVNC_TOKEN_HEX = "0".repeat(64);

/** Default AMM LP fee in basis points (0.30% = 30 bps). */
export const AMM_LP_FEE_BPS = 30n;
export const AMM_FEE_NUMERATOR = 997n;
export const AMM_FEE_DENOMINATOR = 1000n;
export const AMM_MINIMUM_LIQUIDITY = 1_000n;

export interface AmmPoolState {
  poolId: Uint8Array;
  poolIdHex: string;
  token0: Uint8Array;
  token1: Uint8Array;
  token0Address: KovanicaAddress;
  token1Address: KovanicaAddress;
  reserve0: bigint;
  reserve1: bigint;
  totalLpSupply: bigint;
  feeBps: number;
}

export interface AmmSwapQuote {
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  feeAmount: bigint;
  /** Execution price impact in basis points (e.g. 125 = 1.25%). */
  priceImpactBps: number;
  /** Effective execution price (`amountOut / amountIn`, 18-decimal fixed point). */
  executionPriceWad: bigint;
  /** Spot price before swap (`reserveOut / reserveIn`, 18-decimal fixed point). */
  spotPriceWad: bigint;
}

export interface AmmLiquidityQuote {
  amount0Optimal: bigint;
  amount1Optimal: bigint;
  expectedLpMinted: bigint;
  minLpOut: bigint;
  shareOfPoolBps: number;
}

function compareBytes32(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 32; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

function isZeroBytes32(b: Uint8Array): boolean {
  for (let i = 0; i < 32; i++) {
    if (b[i] !== 0) return false;
  }
  return true;
}

function parseTokenBytes(token: Uint8Array | string, label: string): Uint8Array {
  if (token instanceof Uint8Array) {
    if (token.length !== 32) {
      throw new Error(`${label}: expected 32-byte token address, got ${token.length}`);
    }
    return new Uint8Array(token);
  }
  const trimmed = token.trim();
  if (trimmed === "" || trimmed.toUpperCase() === "KVNC" || trimmed === NATIVE_KVNC_TOKEN_HEX || trimmed === `0x${NATIVE_KVNC_TOKEN_HEX}`) {
    return new Uint8Array(32);
  }
  return parseContractAddress(trimmed);
}

function parsePoolIdBytes(poolId: Uint8Array | string): Uint8Array {
  if (poolId instanceof Uint8Array) {
    if (poolId.length !== 32) {
      throw new Error(`poolId: expected 32 bytes, got ${poolId.length}`);
    }
    return new Uint8Array(poolId);
  }
  const clean = poolId.trim().replace(/^0x/i, "");
  if (clean.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error("poolId: expected 32-byte (64-char) hex string");
  }
  return hexToBytes(clean);
}

function readU128Le(bytes: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let i = 15; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[offset + i]!);
  }
  return result;
}

function readU16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function isqrtBigInt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrtBigInt: negative input");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

// ============================================================================
// Pure Pool ID, Quote, Price Impact & Slippage Math
// ============================================================================

/** Canonical token ordering (`token0 < token1`). Rejects identical tokens. */
export function sortAmmTokens(
  tokenA: Uint8Array | string,
  tokenB: Uint8Array | string,
): [Uint8Array, Uint8Array] {
  const a = parseTokenBytes(tokenA, "tokenA");
  const b = parseTokenBytes(tokenB, "tokenB");
  const cmp = compareBytes32(a, b);
  if (cmp === 0) {
    throw new Error("sortAmmTokens: tokenA and tokenB must be distinct");
  }
  return cmp < 0 ? [a, b] : [b, a];
}

/** Deterministic 32-byte pool ID: `blake3("kvnc/v1/amm/pool" || token0 || token1)`. */
export function deriveAmmPoolId(
  tokenA: Uint8Array | string,
  tokenB: Uint8Array | string,
): Uint8Array {
  const [token0, token1] = sortAmmTokens(tokenA, tokenB);
  const prefix = new TextEncoder().encode("kvnc/v1/amm/pool");
  return blake3(concatBytes([prefix, token0, token1]));
}

/**
 * Constant-product (`x * y = k`, 0.30% LP fee) swap quote with exact BigInt math,
 * price impact in basis points, and slippage-adjusted `minAmountOut`.
 */
export function quoteAmmSwapExactIn(params: {
  amountIn: bigint;
  reserveIn: bigint;
  reserveOut: bigint;
  slippageBps?: number;
}): AmmSwapQuote {
  const { amountIn, reserveIn, reserveOut, slippageBps = 50 } = params;
  if (amountIn <= 0n) {
    throw new RangeError("quoteAmmSwapExactIn: amountIn must be > 0");
  }
  if (reserveIn <= 0n || reserveOut <= 0n) {
    throw new RangeError("quoteAmmSwapExactIn: pool has zero liquidity");
  }
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5_000) {
    throw new RangeError("quoteAmmSwapExactIn: slippageBps must be an integer in 0..=5000");
  }

  const amountInWithFee = amountIn * AMM_FEE_NUMERATOR;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * AMM_FEE_DENOMINATOR + amountInWithFee;
  const amountOut = numerator / denominator;
  if (amountOut <= 0n || amountOut >= reserveOut) {
    throw new RangeError("quoteAmmSwapExactIn: insufficient output liquidity");
  }

  const feeAmount = (amountIn * AMM_LP_FEE_BPS) / 10_000n;
  const minAmountOut = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;

  const WAD = 10n ** 18n;
  const spotPriceWad = (reserveOut * WAD) / reserveIn;
  const executionPriceWad = (amountOut * WAD) / amountIn;
  let priceImpactBps = 0;
  if (spotPriceWad > 0n && executionPriceWad < spotPriceWad) {
    priceImpactBps = Number(((spotPriceWad - executionPriceWad) * 10_000n) / spotPriceWad);
  }

  return {
    amountIn,
    amountOut,
    minAmountOut,
    feeAmount,
    priceImpactBps,
    executionPriceWad,
    spotPriceWad,
  };
}

/**
 * Quotes optimal deposit amounts and expected LP shares for `add_liquidity`.
 */
export function quoteAmmAddLiquidity(params: {
  amount0Desired: bigint;
  amount1Desired: bigint;
  reserve0: bigint;
  reserve1: bigint;
  totalLpSupply: bigint;
  slippageBps?: number;
}): AmmLiquidityQuote {
  const {
    amount0Desired,
    amount1Desired,
    reserve0,
    reserve1,
    totalLpSupply,
    slippageBps = 50,
  } = params;
  if (amount0Desired <= 0n || amount1Desired <= 0n) {
    throw new RangeError("quoteAmmAddLiquidity: desired amounts must be > 0");
  }

  let amount0Optimal = amount0Desired;
  let amount1Optimal = amount1Desired;
  let expectedLpMinted: bigint;
  let nextTotalLp: bigint;

  if (totalLpSupply === 0n) {
    const root = isqrtBigInt(amount0Desired * amount1Desired);
    if (root <= AMM_MINIMUM_LIQUIDITY) {
      throw new RangeError("quoteAmmAddLiquidity: initial liquidity below MINIMUM_LIQUIDITY (1000)");
    }
    expectedLpMinted = root - AMM_MINIMUM_LIQUIDITY;
    nextTotalLp = root;
  } else {
    const amount1For0 = (amount0Desired * reserve1) / reserve0;
    if (amount1For0 <= amount1Desired) {
      amount0Optimal = amount0Desired;
      amount1Optimal = amount1For0;
    } else {
      amount0Optimal = (amount1Desired * reserve0) / reserve1;
      amount1Optimal = amount1Desired;
    }
    const lp0 = (amount0Optimal * totalLpSupply) / reserve0;
    const lp1 = (amount1Optimal * totalLpSupply) / reserve1;
    expectedLpMinted = lp0 < lp1 ? lp0 : lp1;
    nextTotalLp = totalLpSupply + expectedLpMinted;
  }

  const minLpOut = (expectedLpMinted * BigInt(10_000 - slippageBps)) / 10_000n;
  const shareOfPoolBps =
    nextTotalLp > 0n ? Number((expectedLpMinted * 10_000n) / nextTotalLp) : 0;

  return {
    amount0Optimal,
    amount1Optimal,
    expectedLpMinted,
    minLpOut,
    shareOfPoolBps,
  };
}

// ============================================================================
// Typed Bincode Encoders & Decoders for `kovanica-amm`
// ============================================================================

export function buildTokenApproveCall(spender: Uint8Array | string, amount: bigint | number): Uint8Array {
  const spenderBytes = parseContractAddress(spender);
  return concatBytes([spenderBytes, u128le(amount)]);
}

export function buildAmmCreatePoolCall(
  tokenA: Uint8Array | string,
  tokenB: Uint8Array | string,
): Uint8Array {
  const a = parseTokenBytes(tokenA, "tokenA");
  const b = parseTokenBytes(tokenB, "tokenB");
  return concatBytes([a, b]);
}

export function buildAmmAddLiquidityCall(params: {
  poolId: Uint8Array | string;
  amount0Desired: bigint | number;
  amount1Desired: bigint | number;
  minLpOut: bigint | number;
}): Uint8Array {
  return concatBytes([
    parsePoolIdBytes(params.poolId),
    u128le(params.amount0Desired),
    u128le(params.amount1Desired),
    u128le(params.minLpOut),
  ]);
}

export function buildAmmRemoveLiquidityCall(params: {
  poolId: Uint8Array | string;
  lpAmount: bigint | number;
  minAmount0: bigint | number;
  minAmount1: bigint | number;
}): Uint8Array {
  return concatBytes([
    parsePoolIdBytes(params.poolId),
    u128le(params.lpAmount),
    u128le(params.minAmount0),
    u128le(params.minAmount1),
  ]);
}

export function buildAmmSwapExactInCall(params: {
  poolId: Uint8Array | string;
  tokenIn: Uint8Array | string;
  amountIn: bigint | number;
  minOut: bigint | number;
}): Uint8Array {
  return concatBytes([
    parsePoolIdBytes(params.poolId),
    parseTokenBytes(params.tokenIn, "tokenIn"),
    u128le(params.amountIn),
    u128le(params.minOut),
  ]);
}

/**
 * Decodes a Bincode-encoded `PoolState` header (`pool_id`, `token0`, `token1`, `reserve0`,
 * `reserve1`, `total_lp_supply`, `fee_bps` = 146 bytes minimum).
 */
export function decodeAmmPoolState(bytes: Uint8Array): AmmPoolState {
  if (bytes.length < 146) {
    throw new Error(`decodeAmmPoolState: expected at least 146 bytes, got ${bytes.length}`);
  }
  const poolId = bytes.slice(0, 32);
  const token0 = bytes.slice(32, 64);
  const token1 = bytes.slice(64, 96);
  const reserve0 = readU128Le(bytes, 96);
  const reserve1 = readU128Le(bytes, 112);
  const totalLpSupply = readU128Le(bytes, 128);
  const feeBps = readU16Le(bytes, 144);
  return {
    poolId,
    poolIdHex: bytesToHex(poolId),
    token0,
    token1,
    token0Address: encodeAddress(token0),
    token1Address: encodeAddress(token1),
    reserve0,
    reserve1,
    totalLpSupply,
    feeBps,
  };
}

// ============================================================================
// Wave A Atomic Batch Builders (1-tx approve + swap / approve + add_liquidity)
// ============================================================================

/**
 * Builds a 1-tx atomic Wave A `Batch` action list for `approve(amm, amountIn) + amm_swap_exact_in`.
 * When `tokenIn` is native `KVNC` (`[0u8; 32]`), skips the KVP-20 `approve` and attaches `value = amountIn`.
 */
export function buildApproveAndSwapBatchActions(params: {
  ammContract: Uint8Array | string;
  poolId: Uint8Array | string;
  tokenIn: Uint8Array | string;
  amountIn: bigint;
  minOut: bigint;
  approveGasLimit?: bigint;
  swapGasLimit?: bigint;
}): BatchAction[] {
  const ammBytes = parseContractAddress(params.ammContract);
  const tokenInBytes = parseTokenBytes(params.tokenIn, "tokenIn");
  const isNative = isZeroBytes32(tokenInBytes);
  const actions: BatchAction[] = [];

  if (!isNative) {
    actions.push({
      kind: "call",
      contract: tokenInBytes,
      value: 0n,
      method: "token_approve",
      args: buildTokenApproveCall(ammBytes, params.amountIn),
      gasLimit: params.approveGasLimit ?? DEFAULT_CALL_GAS_LIMIT,
    });
  }

  actions.push({
    kind: "call",
    contract: ammBytes,
    value: isNative ? params.amountIn : 0n,
    method: "amm_swap_exact_in",
    args: buildAmmSwapExactInCall({
      poolId: params.poolId,
      tokenIn: tokenInBytes,
      amountIn: params.amountIn,
      minOut: params.minOut,
    }),
    gasLimit: params.swapGasLimit ?? DEFAULT_CALL_GAS_LIMIT,
  });

  return actions;
}

/**
 * Builds a 1-tx atomic Wave A `Batch` action list for `approve(token0) + approve(token1) + amm_add_liquidity`.
 * Automatically omits `token_approve` for native `KVNC` and passes it as `Call.value`.
 */
export function buildApproveAndAddLiquidityBatchActions(params: {
  ammContract: Uint8Array | string;
  token0: Uint8Array | string;
  token1: Uint8Array | string;
  amount0Desired: bigint;
  amount1Desired: bigint;
  minLpOut: bigint;
  approveGasLimit?: bigint;
  addLiquidityGasLimit?: bigint;
}): BatchAction[] {
  const ammBytes = parseContractAddress(params.ammContract);
  const [sorted0, sorted1] = sortAmmTokens(params.token0, params.token1);
  const poolId = deriveAmmPoolId(sorted0, sorted1);

  const isNative0 = isZeroBytes32(sorted0);
  const isNative1 = isZeroBytes32(sorted1);
  const actions: BatchAction[] = [];

  if (!isNative0) {
    actions.push({
      kind: "call",
      contract: sorted0,
      value: 0n,
      method: "token_approve",
      args: buildTokenApproveCall(ammBytes, params.amount0Desired),
      gasLimit: params.approveGasLimit ?? DEFAULT_CALL_GAS_LIMIT,
    });
  }
  if (!isNative1) {
    actions.push({
      kind: "call",
      contract: sorted1,
      value: 0n,
      method: "token_approve",
      args: buildTokenApproveCall(ammBytes, params.amount1Desired),
      gasLimit: params.approveGasLimit ?? DEFAULT_CALL_GAS_LIMIT,
    });
  }

  const nativeValue = isNative0 ? params.amount0Desired : isNative1 ? params.amount1Desired : 0n;

  actions.push({
    kind: "call",
    contract: ammBytes,
    value: nativeValue,
    method: "amm_add_liquidity",
    args: buildAmmAddLiquidityCall({
      poolId,
      amount0Desired: params.amount0Desired,
      amount1Desired: params.amount1Desired,
      minLpOut: params.minLpOut,
    }),
    gasLimit: params.addLiquidityGasLimit ?? DEFAULT_CALL_GAS_LIMIT,
  });

  return actions;
}

// ============================================================================
// AmmClient Facade
// ============================================================================

export class AmmClient extends ContractFacade {
  constructor(client: ContractFacadeClient, contract: Uint8Array | string) {
    super(client, contract, "AmmClient");
  }

  derivePoolId(tokenA: Uint8Array | string, tokenB: Uint8Array | string): Uint8Array {
    return deriveAmmPoolId(tokenA, tokenB);
  }

  quoteSwapExactIn(params: {
    amountIn: bigint;
    reserveIn: bigint;
    reserveOut: bigint;
    slippageBps?: number;
  }): AmmSwapQuote {
    return quoteAmmSwapExactIn(params);
  }

  quoteAddLiquidity(params: {
    amount0Desired: bigint;
    amount1Desired: bigint;
    reserve0: bigint;
    reserve1: bigint;
    totalLpSupply: bigint;
    slippageBps?: number;
  }): AmmLiquidityQuote {
    return quoteAmmAddLiquidity(params);
  }

  async prepareCreatePool(
    tokenA: Uint8Array | string,
    tokenB: Uint8Array | string,
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: "amm_create_pool",
      args: buildAmmCreatePoolCall(tokenA, tokenB),
    };
    return estimateAndBuildCall(this.client, call, options);
  }

  async prepareAddLiquidity(
    params: {
      poolId: Uint8Array | string;
      amount0Desired: bigint | number;
      amount1Desired: bigint | number;
      minLpOut: bigint | number;
      value?: bigint | number;
      gasLimit?: bigint | number;
    },
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: "amm_add_liquidity",
      args: buildAmmAddLiquidityCall(params),
      ...(params.value !== undefined ? { value: params.value } : {}),
      ...(params.gasLimit !== undefined ? { gasLimit: params.gasLimit } : {}),
    };
    return estimateAndBuildCall(this.client, call, options);
  }

  async prepareRemoveLiquidity(
    params: {
      poolId: Uint8Array | string;
      lpAmount: bigint | number;
      minAmount0: bigint | number;
      minAmount1: bigint | number;
      gasLimit?: bigint | number;
    },
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: "amm_remove_liquidity",
      args: buildAmmRemoveLiquidityCall(params),
      ...(params.gasLimit !== undefined ? { gasLimit: params.gasLimit } : {}),
    };
    return estimateAndBuildCall(this.client, call, options);
  }

  async prepareSwapExactIn(
    params: {
      poolId: Uint8Array | string;
      tokenIn: Uint8Array | string;
      amountIn: bigint | number;
      minOut: bigint | number;
      value?: bigint | number;
      gasLimit?: bigint | number;
    },
    options?: EstimateAndBuildCallOptions,
  ): Promise<PreparedCallTransaction> {
    const call: CallTxKindInput = {
      contract: this.contractBytes,
      method: "amm_swap_exact_in",
      args: buildAmmSwapExactInCall(params),
      ...(params.value !== undefined ? { value: params.value } : {}),
      ...(params.gasLimit !== undefined ? { gasLimit: params.gasLimit } : {}),
    };
    return estimateAndBuildCall(this.client, call, options);
  }

  /**
   * Builds and signs a 1-tx atomic Wave A `Batch` (`token_approve` + `amm_swap_exact_in`).
   */
  signApproveAndSwapBatch(params: {
    chainId: bigint | number;
    senderPrivateKey: Uint8Array;
    senderPublicKey: Uint8Array;
    nonce: bigint | number;
    fee: bigint | number;
    poolId: Uint8Array | string;
    tokenIn: Uint8Array | string;
    amountIn: bigint;
    minOut: bigint;
    approveGasLimit?: bigint;
    swapGasLimit?: bigint;
  }) {
    const actions = buildApproveAndSwapBatchActions({
      ammContract: this.contractBytes,
      poolId: params.poolId,
      tokenIn: params.tokenIn,
      amountIn: params.amountIn,
      minOut: params.minOut,
      approveGasLimit: params.approveGasLimit,
      swapGasLimit: params.swapGasLimit,
    });
    return {
      actions,
      signed: signBatchTransaction({
        chainId: params.chainId,
        senderPrivateKey: params.senderPrivateKey,
        senderPublicKey: params.senderPublicKey,
        nonce: params.nonce,
        actions,
        fee: params.fee,
      }),
    };
  }

  /**
   * Builds and signs a 1-tx atomic Wave A `Batch` (`token_approve`(s) + `amm_add_liquidity`).
   */
  signApproveAndAddLiquidityBatch(params: {
    chainId: bigint | number;
    senderPrivateKey: Uint8Array;
    senderPublicKey: Uint8Array;
    nonce: bigint | number;
    fee: bigint | number;
    token0: Uint8Array | string;
    token1: Uint8Array | string;
    amount0Desired: bigint;
    amount1Desired: bigint;
    minLpOut: bigint;
    approveGasLimit?: bigint;
    addLiquidityGasLimit?: bigint;
  }) {
    const actions = buildApproveAndAddLiquidityBatchActions({
      ammContract: this.contractBytes,
      token0: params.token0,
      token1: params.token1,
      amount0Desired: params.amount0Desired,
      amount1Desired: params.amount1Desired,
      minLpOut: params.minLpOut,
      approveGasLimit: params.approveGasLimit,
      addLiquidityGasLimit: params.addLiquidityGasLimit,
    });
    return {
      actions,
      signed: signBatchTransaction({
        chainId: params.chainId,
        senderPrivateKey: params.senderPrivateKey,
        senderPublicKey: params.senderPublicKey,
        nonce: params.nonce,
        actions,
        fee: params.fee,
      }),
    };
  }
}
