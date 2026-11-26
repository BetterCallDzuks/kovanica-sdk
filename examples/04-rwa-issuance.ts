/**
 * Example 04 — Institutional RWA (KVP-106) Issuance & Wave A Compliance Batch Allowlist (100% Offline)
 *
 * Demonstrates:
 *   1. Encoding & signing a KVP-106 `rwa_create` call (`buildRwaCreateCall` + `FIXED_FEE_SCHEDULE.rwa_create`)
 *   2. Instantiating `RwaClient` for typed contract interactions
 *   3. Supply-cap preflight check (`checkRwaMintCap`)
 *   4. Signing a Wave A 1-tx atomic compliance batch allowlist update (`signRwaBatchAllowlistUpdate`)
 *   5. Pro-rata coupon/dividend calculation (`computeProRataDividends`)
 *
 * Run (100% offline):
 *   npx tsx examples/04-rwa-issuance.ts
 */

// In external projects, import from "kovanica-sdk" instead of "../src/index.js".
import {
  CHAIN_IDS,
  DEFAULT_CALL_GAS_LIMIT,
  FIXED_FEE_SCHEDULE,
  KovanicaClient,
  KovanicaWallet,
  RwaClient,
  buildCallTxKind,
  buildRwaCreateCall,
  bytesToHex,
  checkRwaMintCap,
  computeProRataDividends,
  decodeSignedCallTransaction,
  encodeAddress,
  formatKvnc,
  parseKvnc,
  signRwaBatchAllowlistUpdate,
  verifyCallTransactionSignature,
} from "../src/index.js";

const env =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

const DEMO_MNEMONIC =
  env.KOVANICA_MNEMONIC ??
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function main(): void {
  // 1. Derive issuer wallet and two accredited investor addresses
  const issuer = KovanicaWallet.fromMnemonic(DEMO_MNEMONIC, "", 0, 0, 0, undefined, {
    chainId: CHAIN_IDS.TESTNET,
  });
  const investorA = KovanicaWallet.fromMnemonic(DEMO_MNEMONIC, "", 0, 0, 1, undefined, {
    chainId: CHAIN_IDS.TESTNET,
  });
  const investorB = KovanicaWallet.fromMnemonic(DEMO_MNEMONIC, "", 0, 0, 2, undefined, {
    chainId: CHAIN_IDS.TESTNET,
  });

  // Example deployed KVP-106 `kovanica-rwa` contract address
  const rwaContract = encodeAddress(new Uint8Array(32).fill(0x55), "tknc");

  // Instantiate RwaClient facade (used for RPC prepareCreate/prepareMint/prepareFreeze when online)
  const client = new KovanicaClient("https://rpc-testnet.kovanica.online/rpc");
  const rwaClient = new RwaClient(client, rwaContract);

  console.log("=== 04. KVP-106 RWA Issuance & Batch Compliance Allowlist ===");
  console.log(`Issuer address  : ${issuer.address}`);
  console.log(`RWA contract    : ${rwaClient.contractAddress}`);

  // 2. Build & sign KVP-106 `rwa_create` call (e.g., tokenized US Treasury bill)
  const metadataHash = new Uint8Array(32).fill(0xab); // BLAKE3/SHA-256 hash of offering memorandum
  const maxSupply = 10_000_000_000_000n; // 10,000,000 units (6 decimals)
  const initialSupply = 1_000_000_000_000n; // 1,000,000 units minted at issuance

  const rwaCreateArgs = buildRwaCreateCall({
    name: "Kovanica Treasury Bill 2026",
    symbol: "KTB26",
    assetClass: "BOND",
    uniqueId: "ISIN-US912797DEMO1",
    version: 1,
    jurisdiction: "CH",
    metadataHash,
    metadataUri: "ipfs://bafybeidemo-metadata-ktb26",
    legalUri: "https://issuer.example.com/ktb26/prospectus.pdf",
    custodyUri: "https://custodian.example.com/attestations/ktb26",
    decimals: 6,
    maxSupply,
    initialSupply,
  });

  const createCall = buildCallTxKind({
    contract: rwaContract,
    method: "rwa_create",
    args: rwaCreateArgs,
    gasLimit: DEFAULT_CALL_GAS_LIMIT,
  });

  const signedCreate = issuer.signCallTransaction(createCall, {
    nonce: 0n,
    fee: FIXED_FEE_SCHEDULE.rwa_create, // 10 KVNC canonical floor
    chainId: CHAIN_IDS.TESTNET,
  });

  const decodedCreate = decodeSignedCallTransaction(signedCreate.rawTxBytes, {
    chainId: CHAIN_IDS.TESTNET,
  });
  const createSigValid = verifyCallTransactionSignature(decodedCreate);
  if (!createSigValid) {
    throw new Error("Offline rwa_create signature verification failed!");
  }

  console.log("\n1) Signed KVP-106 `rwa_create` Call:");
  console.log(`   Fee           : ${formatKvnc(decodedCreate.fee)} KVNC`);
  console.log(`   Args size     : ${decodedCreate.args.length} bytes`);
  console.log(`   Wire size     : ${decodedCreate.wireSizeBytes} bytes`);
  console.log(`   Signing hash  : 0x${signedCreate.sighashHex}`);
  console.log(`   Signature OK  : ${createSigValid}`);

  // 3. Preflight supply-cap check before minting additional units
  const capCheck = checkRwaMintCap({
    currentSupply: initialSupply,
    maxSupply,
    mintAmount: 500_000_000_000n,
  });
  console.log("\n2) Supply-Cap Preflight Check:");
  if (capCheck.allowed) {
    console.log(
      `   Allowed! nextSupply=${capCheck.nextSupply}, remainingCap=${capCheck.remainingCap}`,
    );
  } else {
    console.log(`   Rejected: ${capCheck.reason}`);
  }

  // 4. Sign a 1-tx Wave A atomic compliance batch allowlist update (up to 16 holders per batch)
  const { actions, signed: signedAllowlist } = signRwaBatchAllowlistUpdate({
    chainId: CHAIN_IDS.TESTNET,
    senderPrivateKey: issuer.secretKey,
    senderPublicKey: issuer.publicKey,
    nonce: 1n,
    fee: parseKvnc("0.005"),
    rwaContract,
    entries: [
      { address: investorA.address, allowed: true, kycTier: 2 },
      { address: investorB.address, allowed: true, kycTier: 1 },
    ],
  });

  console.log("\n3) Signed Wave A Batch Allowlist Update:");
  console.log(`   Entries       : ${actions.length} (atomic 1-tx batch)`);
  console.log(`   Signing hash  : 0x${bytesToHex(signedAllowlist.hash)}`);
  console.log(`   Wire size     : ${signedAllowlist.rawBytes.length} bytes`);

  // 5. Compute pro-rata coupon distribution for eligible holders
  const couponPlan = computeProRataDividends({
    holders: [
      { address: investorA.address, balance: 750_000_000_000n },
      { address: investorB.address, balance: 250_000_000_000n },
    ],
    totalPayoutAtoms: parseKvnc("100"), // 100 KVNC coupon pool
  });

  console.log("\n4) Pro-Rata Coupon Distribution Plan (100 KVNC):");
  for (const item of couponPlan.payouts) {
    console.log(
      `   ${item.address.slice(0, 14)}... -> ${formatKvnc(item.payoutAtoms)} KVNC (${item.shareBps / 100}%)`,
    );
  }
  console.log(`   Dust remainder: ${couponPlan.dustRemainderAtoms} atoms`);
}

main();
