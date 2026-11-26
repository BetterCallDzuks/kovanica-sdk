/**
 * Example 02 — KVP-102 Token Creation (`token_create`) with Fee Schedule Inspection
 *
 * Run (queries testnet fee schedule, falls back to canonical FIXED_FEE_SCHEDULE offline):
 *   npx tsx examples/02-deploy-kvp102-token.ts
 *
 * Run 100% offline:
 *   KOVANICA_OFFLINE=1 npx tsx examples/02-deploy-kvp102-token.ts
 *
 * Broadcast to testnet:
 *   KOVANICA_MNEMONIC="..." KOVANICA_TOKEN_CONTRACT="tknc...dag" KOVANICA_BROADCAST=1 npx tsx examples/02-deploy-kvp102-token.ts
 */

// In external projects, import from "kovanica-sdk" instead of "../src/index.js".
import {
  CHAIN_IDS,
  DEFAULT_CALL_GAS_LIMIT,
  FIXED_FEE_SCHEDULE,
  KovanicaClient,
  KovanicaWallet,
  MIN_BASE_FEE_PER_BYTE,
  buildCallTxKind,
  computeTotalRequiredFee,
  concatBytes,
  decodeSignedCallTransaction,
  encodeAddress,
  encodeBincodeString,
  estimateCallTxSize,
  formatKvnc,
  u128le,
  verifyCallTransactionSignature,
} from "../src/index.js";

const env =
  (globalThis as { process?: { env?: Record<string, string | undefined>; exitCode?: number } })
    .process?.env ?? {};

const DEMO_MNEMONIC =
  env.KOVANICA_MNEMONIC ??
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const RPC_URL = env.KOVANICA_RPC_URL ?? "https://rpc-testnet.kovanica.online/rpc";
const OFFLINE_MODE = env.KOVANICA_OFFLINE === "1";
const SHOULD_BROADCAST = env.KOVANICA_BROADCAST === "1";

/**
 * Encodes KVP-102 `token_create(name: String, symbol: String, decimals: u8, initial_supply: u128)`
 * in canonical Bincode 1.x wire format.
 */
function encodeTokenCreateArgs(params: {
  name: string;
  symbol: string;
  decimals: number;
  initialSupply: bigint;
}): Uint8Array {
  return concatBytes([
    encodeBincodeString(params.name),
    encodeBincodeString(params.symbol),
    Uint8Array.of(params.decimals),
    u128le(params.initialSupply),
  ]);
}

async function main(): Promise<void> {
  const creator = KovanicaWallet.fromMnemonic(DEMO_MNEMONIC, "", 0, 0, 0, undefined, {
    chainId: CHAIN_IDS.TESTNET,
  });

  // Deployed `kovanica-token` contract address (override via KOVANICA_TOKEN_CONTRACT for live runs)
  const tokenContract =
    env.KOVANICA_TOKEN_CONTRACT ??
    encodeAddress(new Uint8Array(32).fill(0x22), "tknc");

  console.log("=== 02. KVP-102 Token Creation (`token_create`) ===");
  console.log(`Creator address : ${creator.address}`);
  console.log(`Token contract  : ${tokenContract}`);

  // 1. Inspect canonical Balanced-tier fixed fee schedule (and live RPC schedule when reachable)
  const client = new KovanicaClient({ url: RPC_URL, timeoutMs: 8_000 });
  let tokenCreateFloor: bigint = FIXED_FEE_SCHEDULE.token_create;
  let baseFeePerByte: bigint = MIN_BASE_FEE_PER_BYTE;
  let nonce = 0n;
  let rpcConnected = false;

  console.log("\nCanonical Fixed Fee Schedule (SDK defaults):");
  console.log(`  deploy                : ${formatKvnc(FIXED_FEE_SCHEDULE.deploy)} KVNC`);
  console.log(`  token_create          : ${formatKvnc(FIXED_FEE_SCHEDULE.token_create)} KVNC`);
  console.log(`  nft_create_collection : ${formatKvnc(FIXED_FEE_SCHEDULE.nft_create_collection)} KVNC`);
  console.log(`  rwa_create            : ${formatKvnc(FIXED_FEE_SCHEDULE.rwa_create)} KVNC`);

  if (!OFFLINE_MODE) {
    try {
      const [schedule, baseFee, liveNonce] = await Promise.all([
        client.getFeeSchedule(),
        client.getBaseFee(),
        client.getNonce(creator.address),
      ]);
      tokenCreateFloor = schedule.fixedFees.tokenCreate;
      baseFeePerByte = baseFee.baseFeePerByte;
      nonce = liveNonce;
      rpcConnected = true;
      console.log(`\nLive RPC Fee Schedule (${RPC_URL}):`);
      console.log(`  Active                : ${schedule.active} (from round ${schedule.activeFromRound})`);
      console.log(`  Fee split (burn/miner): ${schedule.feeSplitBurnBps / 100}% / ${schedule.feeSplitMinerBps / 100}%`);
      console.log(`  token_create floor    : ${formatKvnc(tokenCreateFloor)} KVNC`);
      console.log(`  baseFeePerByte        : ${baseFeePerByte} atoms/byte`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`\nRPC unavailable (${msg}); using canonical SDK fee schedule offline.`);
    }
  }

  // 2. Encode KVP-102 `token_create` arguments and build the Call transaction
  const decimals = 6;
  const initialSupply = 1_000_000n * 10n ** BigInt(decimals); // 1,000,000 KUSD
  const args = encodeTokenCreateArgs({
    name: "Kovanica Demo USD",
    symbol: "KUSD",
    decimals,
    initialSupply,
  });

  const call = buildCallTxKind({
    contract: tokenContract,
    method: "token_create",
    args,
    gasLimit: DEFAULT_CALL_GAS_LIMIT,
  });

  // 3. Compute combined fee floor: max(fixedMinFee, txBytes * baseFeePerByte + gasUsed * gasPrice)
  const txBytes = estimateCallTxSize(call);
  const requiredFee = computeTotalRequiredFee({
    fixedMinFee: tokenCreateFloor,
    txBytes,
    baseFeePerByte,
    gasUsed: call.gasLimit,
    gasPrice: 1n,
  });

  // 4. Sign & verify the Call transaction offline
  const signed = creator.signCallTransaction(call, {
    nonce,
    fee: requiredFee,
    chainId: CHAIN_IDS.TESTNET,
  });

  const decoded = decodeSignedCallTransaction(signed.rawTxBytes, {
    chainId: CHAIN_IDS.TESTNET,
  });
  const sigValid = verifyCallTransactionSignature(decoded);
  if (!sigValid) {
    throw new Error("Offline Call transaction signature verification failed!");
  }

  console.log("\nSigned KVP-102 `token_create` Call:");
  console.log(`  Method        : ${decoded.method}`);
  console.log(`  Args size     : ${decoded.args.length} bytes`);
  console.log(`  Wire size     : ${decoded.wireSizeBytes} bytes (estimated ${txBytes} bytes)`);
  console.log(`  Required fee  : ${formatKvnc(decoded.fee)} KVNC (${decoded.fee} atoms)`);
  console.log(`  Signing hash  : 0x${signed.sighashHex}`);
  console.log(`  Signature OK  : ${sigValid}`);

  if (SHOULD_BROADCAST) {
    if (!rpcConnected) {
      throw new Error("Cannot broadcast: RPC endpoint is not connected.");
    }
    const txHash = await client.sendRawTransaction(`0x${signed.rawTxHex}`);
    console.log(`\nBroadcasted! txHash = ${txHash}`);
  } else {
    console.log("\nDry-run complete (not broadcast). Set KOVANICA_BROADCAST=1 to submit to testnet.");
  }
}

main().catch((err) => {
  console.error(err);
  const proc = (globalThis as { process?: { exitCode?: number } }).process;
  if (proc) proc.exitCode = 1;
});
