import { describe, expect, it } from "vitest";
import { encodeAddress } from "../src/address";
import {
  bytesToHex,
  concatBytes,
  encodeBincodeString,
  u32le,
  u64le,
  u128le,
} from "../src/contracts";
import {
  buildRwaAllowlistCall,
  buildRwaBatchAllowlistActions,
  buildRwaForcedTransferCall,
  buildRwaPauseCall,
  buildScheduledRwaDividendJobCall,
  checkRwaMintCap,
  chunkRwaAllowlistBatches,
  computeProRataDividends,
  decodeRwaComplianceState,
  readRwaComplianceStatus,
  signRwaBatchAllowlistUpdate,
} from "../src/rwa-compliance";
import { getPublicKey } from "../src/wallet";

describe("RWA (KVP-106) Compliance, Batch Allowlist & Scheduled Dividend Helpers", () => {
  const rwaContract = new Uint8Array(32).fill(0x55);
  const holder1Bytes = new Uint8Array(32).fill(0x11);
  const holder2Bytes = new Uint8Array(32).fill(0x22);
  const holder1Addr = encodeAddress(holder1Bytes);
  const holder2Addr = encodeAddress(holder2Bytes);

  it("encodes allowlist updates, enforces PRO-21 validation, and signs Wave A batches", () => {
    const single = buildRwaAllowlistCall({ address: holder1Addr, allowed: true, kycTier: 2 });
    expect(single.length).toBe(34);
    expect(single[32]).toBe(1);
    expect(single[33]).toBe(2);

    // Rejects invalid PRO-21 address
    expect(() =>
      buildRwaAllowlistCall({ address: "not-a-valid-address" as never, allowed: true }),
    ).toThrow(/PRO-21/);

    const actions = buildRwaBatchAllowlistActions({
      rwaContract,
      entries: [
        { address: holder1Addr, allowed: true, kycTier: 1 },
        { address: holder2Addr, allowed: false, kycTier: 0 },
      ],
    });
    expect(actions).toHaveLength(2);
    expect(actions[0]?.kind === "call" && actions[0].method).toBe("rwa_set_allowlist");

    // Chunking > 16 entries into multiple Wave A batches
    const manyEntries = Array.from({ length: 20 }, (_, i) => ({
      address: encodeAddress(new Uint8Array(32).fill(i + 1)),
      allowed: true,
    }));
    const chunks = chunkRwaAllowlistBatches({ rwaContract, entries: manyEntries });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(16);
    expect(chunks[1]).toHaveLength(4);

    // Sign batch update
    const priv = new Uint8Array(32).fill(9);
    const pub = getPublicKey(priv);
    const { signed } = signRwaBatchAllowlistUpdate({
      chainId: 2,
      senderPrivateKey: priv,
      senderPublicKey: pub,
      nonce: 3n,
      fee: 20_000_000n,
      rwaContract,
      entries: [{ address: holder1Addr, allowed: true }],
    });
    expect(signed.rawHex.startsWith("0x")).toBe(true);
    expect(signed.signature.length).toBe(64);
  });

  it("encodes pause, forced transfer/clawback with reason, and checks mint caps", () => {
    expect(buildRwaPauseCall(true)).toEqual(Uint8Array.of(1));
    expect(buildRwaPauseCall(false)).toEqual(Uint8Array.of(0));

    const clawback = buildRwaForcedTransferCall({
      from: holder1Addr,
      to: holder2Addr,
      amount: 500n,
      reason: "Court order #2026-88",
    });
    expect(clawback.length).toBe(32 + 32 + 16 + 8 + "Court order #2026-88".length);

    expect(() =>
      buildRwaForcedTransferCall({ from: holder1Addr, to: holder2Addr, amount: 1n, reason: "  " }),
    ).toThrow(/reason/);

    expect(
      checkRwaMintCap({ currentSupply: 900n, maxSupply: 1000n, mintAmount: 100n }),
    ).toEqual({ allowed: true, nextSupply: 1000n, remainingCap: 0n });

    const exceeded = checkRwaMintCap({ currentSupply: 900n, maxSupply: 1000n, mintAmount: 101n });
    expect(exceeded.allowed).toBe(false);
  });

  it("decodes on-chain RwaState compliance status from storage", async () => {
    const assetId = new Uint8Array(32).fill(0xaa);
    const metaHash = new Uint8Array(32).fill(0xbb);
    const issuer = new Uint8Array(32).fill(0xcc);
    const encoded = concatBytes([
      assetId,
      encodeBincodeString("US Treasury 2027"),
      encodeBincodeString("USTB27"),
      encodeBincodeString("BOND"),
      encodeBincodeString("US912828"),
      u32le(1),
      encodeBincodeString("US"),
      metaHash,
      encodeBincodeString("ipfs://meta"),
      encodeBincodeString("ipfs://legal"),
      encodeBincodeString("ipfs://custody"),
      issuer,
      Uint8Array.of(6),
      u128le(10_000_000n),
      u128le(1_500_000n),
      Uint8Array.of(0), // paused = false
      // balances map (2 entries)
      u64le(2),
      holder1Bytes,
      u128le(1_000_000n),
      holder2Bytes,
      u128le(500_000n),
      // frozen map (1 entry: holder2 frozen)
      u64le(1),
      holder2Bytes,
      Uint8Array.of(1),
    ]);

    const status = decodeRwaComplianceState(encoded);
    expect(status.symbol).toBe("USTB27");
    expect(status.assetClass).toBe("BOND");
    expect(status.paused).toBe(false);
    expect(status.holderCount).toBe(2);
    expect(status.frozenCount).toBe(1);
    expect(status.frozenAccounts).toEqual([holder2Addr]);

    const readBack = await readRwaComplianceStatus(
      { getStorageAt: async () => `0x${bytesToHex(encoded)}` },
      rwaContract,
    );
    expect(readBack?.name).toBe("US Treasury 2027");
  });

  it("computes pro-rata dividends and builds kovanica-scheduler job payload", () => {
    const plan = computeProRataDividends({
      totalPayoutAtoms: 1_000_000_000n,
      holders: [
        { address: holder1Addr, balance: 750n },
        { address: holder2Addr, balance: 250n },
      ],
    });
    expect(plan.payouts).toHaveLength(2);
    expect(plan.payouts[0]?.payoutAtoms).toBe(750_000_000n);
    expect(plan.payouts[1]?.payoutAtoms).toBe(250_000_000n);
    expect(plan.dustRemainderAtoms).toBe(0n);

    // Excluding frozen holder redirects 100% to eligible holders
    const filtered = computeProRataDividends({
      totalPayoutAtoms: 1_000_000_000n,
      holders: [
        { address: holder1Addr, balance: 750n },
        { address: holder2Addr, balance: 250n },
      ],
      excludedAddresses: new Set([holder2Addr]),
    });
    expect(filtered.payouts).toHaveLength(1);
    expect(filtered.payouts[0]?.payoutAtoms).toBe(1_000_000_000n);

    const jobPayload = buildScheduledRwaDividendJobCall({
      rwaContract,
      payoutToken: "KVNC",
      totalPayoutAtoms: 1_000_000_000n,
      epochId: 1,
      memo: "Q4 2026 Coupon",
      executeAfterHeight: 100_000n,
      intervalHeights: 21_600n,
      maxRuns: 12,
      bountyPerRun: 50_000_000n,
    });
    expect(jobPayload.length).toBeGreaterThan(80);
  });
});
