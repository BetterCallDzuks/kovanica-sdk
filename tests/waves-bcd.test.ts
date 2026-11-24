import { describe, expect, it } from "vitest";
import {
  FIXED_FEE_SCHEDULE,
  ML_DSA_65_PUBKEY_BYTES,
  ML_DSA_65_SIG_BYTES,
  STORAGE_DEPOSIT_PER_BYTE,
  SignatureScheme,
  TARGET_BLOCK_BYTES,
  buildBridgeAttestMintCall,
  buildBridgeInitCall,
  buildBridgeWithdrawCall,
  buildSchedulerCreateJobCall,
  buildSchedulerJobIdCall,
  checkSessionPolicy,
  computePqHybridDigest,
  computeStorageDepositDelta,
  computeTotalRequiredFee,
  deriveTypedAddress,
  nextBaseFeePerByte,
} from "../src";

describe("Waves B, C, and D SDK utilities", () => {
  it("computes EIP-1559 dynamic base fee, storage deposit deltas, and gas-priced fee floor", () => {
    expect(nextBaseFeePerByte(100n, TARGET_BLOCK_BYTES)).toBe(100n);
    expect(nextBaseFeePerByte(100n, TARGET_BLOCK_BYTES * 2)).toBe(112n);
    expect(nextBaseFeePerByte(100n, 0)).toBe(88n);
    expect(computeStorageDepositDelta(0, 1024)).toBe(1024n * STORAGE_DEPOSIT_PER_BYTE);
    expect(computeStorageDepositDelta(1024, 512)).toBe(-512n * STORAGE_DEPOSIT_PER_BYTE);
    expect(
      computeTotalRequiredFee({
        fixedMinFee: FIXED_FEE_SCHEDULE.token_create,
        txBytes: 300,
        baseFeePerByte: 1n,
        gasUsed: 50_000n,
        gasPrice: 1n,
      }),
    ).toBe(FIXED_FEE_SCHEDULE.token_create);
  });

  it("derives scheme-separated Passkey/PQ addresses and enforces SessionKeyPolicy", () => {
    const pk = new Uint8Array(32).fill(0x55);
    const ed = deriveTypedAddress(SignatureScheme.Ed25519, pk);
    const p256 = deriveTypedAddress(SignatureScheme.Secp256r1WebAuthn, pk);
    const pq = deriveTypedAddress(SignatureScheme.MlDsa65Hybrid, pk);
    expect(ed).not.toEqual(p256);
    expect(p256).not.toEqual(pq);
    expect(ML_DSA_65_PUBKEY_BYTES).toBe(1952);
    expect(ML_DSA_65_SIG_BYTES).toBe(3309);
    expect(computePqHybridDigest(pk, pk, pk).length).toBe(32);

    const policy = {
      owner: "kvnc_owner",
      sessionPubkey: "kvnc_sess",
      allowedContracts: ["kvnc_nft"],
      allowedMethods: ["nft_mint"],
      maxSpendAtoms: 500_000_000n,
      spentAtoms: 0n,
      expiresRound: 1000n,
      revoked: false,
    };
    expect(checkSessionPolicy(policy, "kvnc_nft", "nft_mint", 100_000_000n, 500n).allowed).toBe(
      true,
    );
    expect(checkSessionPolicy(policy, "kvnc_other", "nft_mint", 100_000_000n, 500n).allowed).toBe(
      false,
    );
    expect(checkSessionPolicy(policy, "kvnc_nft", "nft_mint", 100_000_000n, 1000n).allowed).toBe(
      false,
    );
  });

  it("encodes Scheduler and Bridge contract calls", () => {
    const addr = new Uint8Array(32).fill(0x22);
    expect(
      buildSchedulerCreateJobCall({
        targetContract: addr,
        method: "rwa_mint",
        args: new Uint8Array([1, 2, 3]),
        executeAfterHeight: 100n,
        intervalHeights: 2400n,
        maxRuns: 12,
        bountyPerRun: 1_000_000n,
      }).length,
    ).toBeGreaterThan(64);
    expect(buildSchedulerJobIdCall(0n).length).toBe(8);
    expect(
      buildBridgeInitCall({
        wrappedToken: addr,
        assetSymbol: "wUSDC",
        relayers: [addr],
        threshold: 1,
      }).length,
    ).toBeGreaterThan(64);
    expect(
      buildBridgeAttestMintCall({
        sourceChainId: 1n,
        sourceTxHash: addr,
        recipient: addr,
        amount: 1_000_000n,
      }).length,
    ).toBe(88);
    expect(
      buildBridgeWithdrawCall({
        destChainId: 1n,
        destAddress: new Uint8Array(20).fill(0xaa),
        amount: 500_000n,
      }).length,
    ).toBe(52);
  });
});
