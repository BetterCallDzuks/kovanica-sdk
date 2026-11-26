/**
 * Example 01 — Native KVNC Transfer (BIP-44 Wallet + Balance Check + Offline Sign + Optional Broadcast)
 *
 * Run (dry-run against testnet RPC, falls back to offline if unreachable):
 *   npx tsx examples/01-transfer-kvnc.ts
 *
 * Run 100% offline:
 *   KOVANICA_OFFLINE=1 npx tsx examples/01-transfer-kvnc.ts
 *
 * Broadcast to testnet (requires a funded account):
 *   KOVANICA_MNEMONIC="..." KOVANICA_BROADCAST=1 npx tsx examples/01-transfer-kvnc.ts
 */

// In external projects, import from "kovanica-sdk" instead of "../src/index.js".
import {
  CHAIN_IDS,
  KovanicaClient,
  KovanicaWallet,
  decodeSignedTransferTransaction,
  formatBip44Path,
  formatKvnc,
  parseKvnc,
  signTransferTransaction,
  verifyTransferTransactionSignature,
} from "../src/index.js";

const env =
  (globalThis as { process?: { env?: Record<string, string | undefined>; exitCode?: number } })
    .process?.env ?? {};

// Standard BIP-39 test vector mnemonic — DO NOT use for real funds.
const DEMO_MNEMONIC =
  env.KOVANICA_MNEMONIC ??
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const RPC_URL = env.KOVANICA_RPC_URL ?? "https://rpc-testnet.kovanica.online/rpc";
const OFFLINE_MODE = env.KOVANICA_OFFLINE === "1";
const SHOULD_BROADCAST = env.KOVANICA_BROADCAST === "1";

async function main(): Promise<void> {
  // 1. Derive sender (index 0) and recipient (index 1) from BIP-44 SLIP-0010 path m/44'/3007'/0'/0'/<index>'
  const sender = KovanicaWallet.fromMnemonic(DEMO_MNEMONIC, "", 0, 0, 0, undefined, {
    chainId: CHAIN_IDS.TESTNET,
  });
  const recipient = KovanicaWallet.fromMnemonic(DEMO_MNEMONIC, "", 0, 0, 1, undefined, {
    chainId: CHAIN_IDS.TESTNET,
  });

  console.log("=== 01. Native KVNC Transfer ===");
  console.log(`Derivation path : ${formatBip44Path(0, 0, 0)}`);
  console.log(`Sender address  : ${sender.address}`);
  console.log(`Recipient       : ${recipient.address}`);

  // 2. Query testnet balance, nonce, and fee rate (with graceful offline fallback)
  const client = new KovanicaClient({ url: RPC_URL, timeoutMs: 8_000 });
  let balance = 0n;
  let nonce = 0n;
  let fee = parseKvnc("0.001"); // 1,000,000 atoms fallback fee
  let rpcConnected = false;

  if (!OFFLINE_MODE) {
    try {
      const [liveBalance, liveNonce, feeRatePerByte] = await Promise.all([
        client.getBalance(sender.address),
        client.getNonce(sender.address),
        client.estimateFee(),
      ]);
      balance = liveBalance;
      nonce = liveNonce;
      // Transfer wire size is exactly 196 bytes; apply a 2x safety cushion.
      const estimated = feeRatePerByte * 196n * 2n;
      fee = estimated > fee ? estimated : fee;
      rpcConnected = true;
      console.log(`RPC endpoint    : ${RPC_URL} (connected)`);
      console.log(`Sender balance  : ${formatKvnc(balance)} KVNC (${balance} atoms)`);
      console.log(`Sender nonce    : ${nonce}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`RPC endpoint    : ${RPC_URL} (unreachable: ${msg})`);
      console.log("Continuing in offline dry-run mode with nonce=0.");
    }
  } else {
    console.log("Mode            : KOVANICA_OFFLINE=1 (skipping RPC calls)");
  }

  // 3. Build & sign the native KVNC transfer offline
  const amount = parseKvnc("1.25"); // 1.25 KVNC = 1_250_000_000 atoms
  const signed = signTransferTransaction({
    privateKey: sender.secretKey,
    to: recipient.address,
    amount,
    nonce,
    fee,
    chainId: CHAIN_IDS.TESTNET,
  });

  // 4. Decode and verify the Ed25519 signature locally before any broadcast
  const decoded = decodeSignedTransferTransaction(signed.rawTxBytes, {
    chainId: CHAIN_IDS.TESTNET,
  });
  const sigValid = verifyTransferTransactionSignature(decoded);
  if (!sigValid) {
    throw new Error("Offline Ed25519 signature verification failed!");
  }

  console.log("\nSigned Transfer Transaction:");
  console.log(`  Amount        : ${formatKvnc(decoded.amount)} KVNC`);
  console.log(`  Fee           : ${formatKvnc(decoded.fee)} KVNC`);
  console.log(`  Nonce         : ${decoded.nonce}`);
  console.log(`  Wire size     : ${decoded.wireSizeBytes} bytes`);
  console.log(`  Signing hash  : 0x${signed.signingHashHex}`);
  console.log(`  Signature OK  : ${sigValid}`);
  console.log(`  Raw tx (hex)  : 0x${signed.rawTxHex.slice(0, 64)}... (${signed.rawTxBytes.length} bytes)`);

  // 5. Optional broadcast (explicit opt-in via KOVANICA_BROADCAST=1)
  if (SHOULD_BROADCAST) {
    if (!rpcConnected) {
      throw new Error("Cannot broadcast: RPC endpoint is not connected.");
    }
    if (balance < amount + fee) {
      throw new Error(
        `Insufficient testnet balance (${formatKvnc(balance)} KVNC) for amount + fee (${formatKvnc(amount + fee)} KVNC).`,
      );
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
