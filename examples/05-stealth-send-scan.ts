/**
 * Example 05 — KVP-103 Dual-Key Ed25519 Stealth Addresses (100% Offline End-to-End)
 *
 * Demonstrates the complete KVP-103 privacy flow without any network access:
 *   1. Receiver generates a dual-key stealth keypair & `st:kvnc:<scanPub>:<spendPub>` meta-address
 *   2. Sender derives a fresh, unlinkable one-time L1 address + ephemeral pubkey R + 2-byte view tag
 *   3. Receiver watch-only scans public announcements using ONLY `(scanPrivkeyHex, spendPubkeyHex)`
 *      (the spend private key never touches the scanner)
 *   4. Receiver recovers the one-time Ed25519 spend scalar `p = (b + t) mod L`
 *   5. Receiver signs a 32-byte L1 transaction sighash with `p` and verifies it under RFC 8032 Ed25519
 *
 * Run (100% offline):
 *   npx tsx examples/05-stealth-send-scan.ts
 */

// In external projects, import from "kovanica-sdk" instead of "../src/index.js".
import {
  CHAIN_IDS,
  bytesToHex,
  computeTransferTransactionSigningHash,
  deriveOnetimeAddress,
  deriveOnetimeSpendKey,
  generateStealthKeypair,
  hexToBytes,
  isValidStealthMetaAddress,
  parseKvnc,
  scanStealthAnnouncements,
  signSighashWithStealthScalar,
  verifyEd25519,
} from "../src/index.js";

function main(): void {
  console.log("=== 05. KVP-103 Dual-Key Ed25519 Stealth Addresses (100% Offline) ===");

  // 1. Receiver generates a dual-key stealth identity (scan key v/V + spend key b/B)
  const receiver = generateStealthKeypair();
  const thirdParty = generateStealthKeypair();

  if (!isValidStealthMetaAddress(receiver.metaAddress)) {
    throw new Error("Generated stealth meta-address failed validation!");
  }

  console.log("\n1) Receiver Stealth Meta-Address (safe to publish):");
  console.log(`   ${receiver.metaAddress}`);

  // 2. Sender derives a fresh one-time L1 address + ephemeral pubkey R + 2-byte viewTag
  const payment = deriveOnetimeAddress(receiver.metaAddress);
  // Also create a decoy announcement for another recipient to prove fast filtering
  const decoy = deriveOnetimeAddress(thirdParty.metaAddress);

  console.log("\n2) Sender Derived One-Time Payment:");
  console.log(`   One-time address : ${payment.address}`);
  console.log(`   Ephemeral R      : 0x${payment.ephemeralPubkeyHex}`);
  console.log(`   View tag (2B)    : 0x${payment.viewTag}`);

  // 3. Receiver watch-only scans public announcements using ONLY (scanPrivkeyHex, spendPubkeyHex)
  const publicFeed = [
    {
      ephemeralPubkeyHex: decoy.ephemeralPubkeyHex,
      viewTag: decoy.viewTag,
      stealthAddress: decoy.address,
      txHash: "0x" + "00".repeat(32),
    },
    {
      ephemeralPubkeyHex: payment.ephemeralPubkeyHex,
      viewTag: payment.viewTag,
      stealthAddress: payment.address,
      txHash: "0x" + "11".repeat(32),
    },
  ];

  const matches = scanStealthAnnouncements({
    scanPrivkeyHex: receiver.scanPrivkeyHex,
    spendPubkeyHex: receiver.spendPubkeyHex,
    announcements: publicFeed,
  });

  if (matches.length !== 1 || matches[0]!.address !== payment.address) {
    throw new Error(`Expected exactly 1 stealth match for ${payment.address}, got ${matches.length}`);
  }

  const matched = matches[0]!;
  console.log("\n3) Receiver Watch-Only Scan Result:");
  console.log(`   Scanned          : ${publicFeed.length} announcements (1 decoy + 1 real)`);
  console.log(`   Matched          : ${matches.length}`);
  console.log(`   Matched address  : ${matched.address}`);
  console.log(`   Matched viewTag  : 0x${matched.viewTag}`);

  // 4. Receiver recovers the one-time Ed25519 spend scalar p = (b + t) mod L
  const spendKey = deriveOnetimeSpendKey({
    scanPrivkeyHex: receiver.scanPrivkeyHex,
    spendPrivkeyHex: receiver.spendPrivkeyHex,
    ephemeralPubkeyHex: matched.ephemeralPubkeyHex,
  });

  if (spendKey.address !== payment.address || spendKey.addressHex !== payment.addressHex) {
    throw new Error("Recovered one-time spend key address mismatch!");
  }

  console.log("\n4) Recovered One-Time Spend Key:");
  console.log(`   Address matches  : ${spendKey.address === payment.address}`);
  console.log(`   One-time pubkey  : 0x${spendKey.addressHex}`);

  // 5. Sign a standard L1 Transfer sighash with the recovered scalar and verify under RFC 8032 Ed25519
  const sweepDestination = new Uint8Array(32).fill(0x77);
  const sighash = computeTransferTransactionSigningHash(
    {
      sender: hexToBytes(spendKey.addressHex),
      to: sweepDestination,
      amount: parseKvnc("5"),
      nonce: 0n,
      fee: parseKvnc("0.001"),
    },
    CHAIN_IDS.TESTNET,
  );
  const sighashHex = bytesToHex(sighash);

  const { signatureHex, publicKeyHex } = signSighashWithStealthScalar(
    spendKey.oneTimeScalarHex,
    sighashHex,
  );

  const verified = verifyEd25519(
    hexToBytes(signatureHex),
    sighash,
    hexToBytes(publicKeyHex),
  );

  if (!verified) {
    throw new Error("RFC 8032 Ed25519 verification of stealth spend signature failed!");
  }

  console.log("\n5) Spend Sighash Signed & Verified (RFC 8032 Ed25519):");
  console.log(`   Sighash          : 0x${sighashHex}`);
  console.log(`   Signature        : 0x${signatureHex.slice(0, 32)}... (64 bytes)`);
  console.log(`   Ed25519 verified : ${verified}`);
}

main();
