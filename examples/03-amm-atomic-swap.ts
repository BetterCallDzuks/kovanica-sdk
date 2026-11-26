/**
 * Example 03 — Native AMM Quote & Wave A 1-Tx Atomic `Approve → Swap` Batch (100% Offline)
 *
 * Demonstrates:
 *   1. Deterministic pool ID derivation (`deriveAmmPoolId`)
 *   2. Exact BigInt constant-product quote + price impact + slippage (`quoteAmmSwapExactIn`)
 *   3. Building & signing a Wave A 1-tx atomic `Batch` (`token_approve` + `amm_swap_exact_in`)
 *      via `AmmClient.signApproveAndSwapBatch`
 *
 * Run (100% offline):
 *   npx tsx examples/03-amm-atomic-swap.ts
 */

// In external projects, import from "kovanica-sdk" instead of "../src/index.js".
import {
  AmmClient,
  CHAIN_IDS,
  KovanicaClient,
  KovanicaWallet,
  NATIVE_KVNC_TOKEN,
  bytesToHex,
  deriveAmmPoolId,
  encodeAddress,
  formatKvnc,
  parseKvnc,
  quoteAmmSwapExactIn,
} from "../src/index.js";

const env =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

const DEMO_MNEMONIC =
  env.KOVANICA_MNEMONIC ??
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function main(): void {
  // 1. Derive trader wallet
  const trader = KovanicaWallet.fromMnemonic(DEMO_MNEMONIC, "", 0, 0, 0, undefined, {
    chainId: CHAIN_IDS.TESTNET,
  });

  // Example deployed AMM contract & KVP-102 token contract addresses
  const ammContract = encodeAddress(new Uint8Array(32).fill(0x33), "tknc");
  const kusdToken = encodeAddress(new Uint8Array(32).fill(0x44), "tknc");

  // 2. Derive deterministic pool ID for the (KUSD / native KVNC) pair
  const poolId = deriveAmmPoolId(kusdToken, NATIVE_KVNC_TOKEN);

  // 3. Quote swapping 250 KUSD (6 decimals) -> KVNC (9 decimals) against sample pool reserves
  const amountIn = 250_000_000n; // 250 KUSD
  const reserveIn = 50_000_000_000n; // 50,000 KUSD
  const reserveOut = parseKvnc("100000"); // 100,000 KVNC
  const slippageBps = 50; // 0.50% max slippage

  const quote = quoteAmmSwapExactIn({
    amountIn,
    reserveIn,
    reserveOut,
    slippageBps,
  });

  console.log("=== 03. Native AMM Quote & Wave A Atomic Approve -> Swap ===");
  console.log(`Trader address  : ${trader.address}`);
  console.log(`AMM contract    : ${ammContract}`);
  console.log(`Input token     : ${kusdToken} (KUSD)`);
  console.log(`Pool ID         : 0x${bytesToHex(poolId)}`);

  console.log("\nConstant-Product Swap Quote (0.30% LP fee):");
  console.log(`  amountIn      : ${amountIn} base units (250 KUSD)`);
  console.log(`  LP fee        : ${quote.feeAmount} base units`);
  console.log(`  amountOut     : ${formatKvnc(quote.amountOut)} KVNC`);
  console.log(`  minAmountOut  : ${formatKvnc(quote.minAmountOut)} KVNC (${slippageBps / 100}% slippage)`);
  console.log(`  priceImpact   : ${(quote.priceImpactBps / 100).toFixed(2)}% (${quote.priceImpactBps} bps)`);

  // 4. Build & sign a Wave A 1-tx atomic Batch (`token_approve` + `amm_swap_exact_in`)
  //    KovanicaClient is only passed to construct AmmClient; no network calls are made here.
  const client = new KovanicaClient("https://rpc-testnet.kovanica.online/rpc");
  const amm = new AmmClient(client, ammContract);

  const { actions, signed } = amm.signApproveAndSwapBatch({
    chainId: CHAIN_IDS.TESTNET,
    senderPrivateKey: trader.secretKey,
    senderPublicKey: trader.publicKey,
    nonce: 0n,
    fee: parseKvnc("0.005"),
    poolId,
    tokenIn: kusdToken,
    amountIn,
    minOut: quote.minAmountOut,
  });

  console.log("\nWave A Atomic Batch Transaction:");
  console.log(`  Action count  : ${actions.length}`);
  actions.forEach((action, idx) => {
    if (action.kind === "call") {
      console.log(
        `    [${idx + 1}] Call ${action.method} (args=${action.args.length}B, gasLimit=${action.gasLimit})`,
      );
    }
  });
  console.log(`  Signing hash  : 0x${bytesToHex(signed.hash)}`);
  console.log(`  Signature     : 0x${bytesToHex(signed.signature).slice(0, 32)}... (64 bytes)`);
  console.log(`  Wire size     : ${signed.rawBytes.length} bytes`);
  console.log(`  Raw tx (hex)  : ${signed.rawHex.slice(0, 66)}...`);
}

main();
