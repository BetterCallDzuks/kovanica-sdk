import { describe, expect, it } from "vitest";
import {
  AMM_LP_FEE_BPS,
  AmmClient,
  NATIVE_KVNC_TOKEN,
  buildAmmAddLiquidityCall,
  buildAmmCreatePoolCall,
  buildAmmRemoveLiquidityCall,
  buildAmmSwapExactInCall,
  buildApproveAndAddLiquidityBatchActions,
  buildApproveAndSwapBatchActions,
  decodeAmmPoolState,
  deriveAmmPoolId,
  quoteAmmAddLiquidity,
  quoteAmmSwapExactIn,
  sortAmmTokens,
} from "../src/amm";
import { concatBytes, u128le } from "../src/contracts";
import { getPublicKey } from "../src/wallet";

describe("Native AMM / DEX (AmmClient & helpers)", () => {
  const ammContract = new Uint8Array(32).fill(0x99);
  const tokenA = new Uint8Array(32).fill(0x11);
  const tokenB = new Uint8Array(32).fill(0x22);

  it("sorts tokens canonically and derives identical poolId regardless of order", () => {
    const [s0, s1] = sortAmmTokens(tokenB, tokenA);
    expect(s0).toEqual(tokenA);
    expect(s1).toEqual(tokenB);

    const pid1 = deriveAmmPoolId(tokenA, tokenB);
    const pid2 = deriveAmmPoolId(tokenB, tokenA);
    expect(pid1).toEqual(pid2);
    expect(pid1.length).toBe(32);

    // Native KVNC sorts before any non-zero KVP-20
    const [n0, n1] = sortAmmTokens(tokenA, "KVNC");
    expect(n0).toEqual(NATIVE_KVNC_TOKEN);
    expect(n1).toEqual(tokenA);

    expect(() => sortAmmTokens(tokenA, tokenA)).toThrow(/distinct/);
  });

  it("matches exact 0.30% LP fee constant-product quote math and price impact", () => {
    expect(AMM_LP_FEE_BPS).toBe(30n);
    const quote = quoteAmmSwapExactIn({
      amountIn: 10_000_000n,
      reserveIn: 1_000_000_000n,
      reserveOut: 1_000_000_000n,
      slippageBps: 50,
    });
    // Exact match with Rust contract test vector: 9_871_580
    expect(quote.amountOut).toBe(9_871_580n);
    expect(quote.feeAmount).toBe(30_000n);
    expect(quote.minAmountOut).toBe((9_871_580n * 9_950n) / 10_000n);
    expect(quote.priceImpactBps).toBeGreaterThan(100);
    expect(quote.priceImpactBps).toBeLessThan(150);

    expect(() =>
      quoteAmmSwapExactIn({ amountIn: 1_000n, reserveIn: 0n, reserveOut: 1_000n }),
    ).toThrow(/zero liquidity/);
  });

  it("quotes initial and subsequent addLiquidity accurately", () => {
    const initQuote = quoteAmmAddLiquidity({
      amount0Desired: 1_000_000n,
      amount1Desired: 4_000_000n,
      reserve0: 0n,
      reserve1: 0n,
      totalLpSupply: 0n,
    });
    expect(initQuote.expectedLpMinted).toBe(1_999_000n);

    const nextQuote = quoteAmmAddLiquidity({
      amount0Desired: 500_000n,
      amount1Desired: 3_000_000n,
      reserve0: 1_000_000n,
      reserve1: 4_000_000n,
      totalLpSupply: 2_000_000n,
    });
    expect(nextQuote.amount0Optimal).toBe(500_000n);
    expect(nextQuote.amount1Optimal).toBe(2_000_000n);
    expect(nextQuote.expectedLpMinted).toBe(1_000_000n);
  });

  it("encodes Bincode call payloads and decodes PoolState", () => {
    const pid = deriveAmmPoolId(tokenA, tokenB);
    expect(buildAmmCreatePoolCall(tokenA, tokenB).length).toBe(64);
    expect(
      buildAmmAddLiquidityCall({
        poolId: pid,
        amount0Desired: 1000n,
        amount1Desired: 2000n,
        minLpOut: 100n,
      }).length,
    ).toBe(32 + 16 * 3);
    expect(
      buildAmmRemoveLiquidityCall({
        poolId: pid,
        lpAmount: 500n,
        minAmount0: 100n,
        minAmount1: 200n,
      }).length,
    ).toBe(32 + 16 * 3);
    expect(
      buildAmmSwapExactInCall({
        poolId: pid,
        tokenIn: tokenA,
        amountIn: 500n,
        minOut: 400n,
      }).length,
    ).toBe(32 + 32 + 16 * 2);

    const encodedPool = concatBytes([
      pid,
      tokenA,
      tokenB,
      u128le(1_000_000n),
      u128le(2_000_000n),
      u128le(1_414_213n),
      Uint8Array.of(30, 0),
    ]);
    const decoded = decodeAmmPoolState(encodedPool);
    expect(decoded.reserve0).toBe(1_000_000n);
    expect(decoded.reserve1).toBe(2_000_000n);
    expect(decoded.totalLpSupply).toBe(1_414_213n);
    expect(decoded.feeBps).toBe(30);
  });

  it("builds 1-tx Wave A atomic Batch for approve+swap and approve+add_liquidity", () => {
    const pid = deriveAmmPoolId(tokenA, tokenB);
    // KVP-20 input includes token_approve + amm_swap_exact_in (2 actions)
    const swapActions = buildApproveAndSwapBatchActions({
      ammContract,
      poolId: pid,
      tokenIn: tokenA,
      amountIn: 50_000n,
      minOut: 49_000n,
    });
    expect(swapActions).toHaveLength(2);
    expect(swapActions[0]?.kind === "call" && swapActions[0].method).toBe("token_approve");
    expect(swapActions[1]?.kind === "call" && swapActions[1].method).toBe("amm_swap_exact_in");

    // Native KVNC input skips token_approve and sets Call.value (1 action)
    const nativeSwapActions = buildApproveAndSwapBatchActions({
      ammContract,
      poolId: deriveAmmPoolId(NATIVE_KVNC_TOKEN, tokenB),
      tokenIn: "KVNC",
      amountIn: 50_000n,
      minOut: 49_000n,
    });
    expect(nativeSwapActions).toHaveLength(1);
    expect(nativeSwapActions[0]?.kind === "call" && nativeSwapActions[0].value).toBe(50_000n);

    // KVP-20/KVP-20 add_liquidity includes 2 approves + 1 add_liquidity (3 actions)
    const addActions = buildApproveAndAddLiquidityBatchActions({
      ammContract,
      token0: tokenA,
      token1: tokenB,
      amount0Desired: 1_000_000n,
      amount1Desired: 2_000_000n,
      minLpOut: 1_000n,
    });
    expect(addActions).toHaveLength(3);

    // Sign batch via AmmClient
    const mockClient = {
      call: async () => "0x",
      estimateFee: async () => 10_000_000n,
      getNonce: async () => 0n,
      getStorageAt: async () => null,
    };
    const amm = new AmmClient(mockClient, ammContract);
    const priv = new Uint8Array(32).fill(7);
    const pub = getPublicKey(priv);
    const { signed } = amm.signApproveAndSwapBatch({
      chainId: 2,
      senderPrivateKey: priv,
      senderPublicKey: pub,
      nonce: 1n,
      fee: 20_000_000n,
      poolId: pid,
      tokenIn: tokenA,
      amountIn: 50_000n,
      minOut: 49_000n,
    });
    expect(signed.rawHex.startsWith("0x")).toBe(true);
    expect(signed.signature.length).toBe(64);
  });
});
