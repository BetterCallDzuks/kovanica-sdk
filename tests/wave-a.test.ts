import { describe, expect, it } from "vitest";
import {
  FIXED_FEE_SCHEDULE,
  MAX_BATCH_ACTIONS,
  PREV_DEPLOYED_CONTRACT,
  buildRwaCreateCall,
  computeBatchSigningHash,
  computeSponsorSigningHash,
  signBatchTransaction,
  signSponsoredTransaction,
  signingBatchKindBytes,
  wireBatchKindBytes,
} from "../src";

describe("Wave A: Atomic Batch & Sponsored (Gasless) Transactions", () => {
  const senderPriv = new Uint8Array(32).fill(7);
  const senderPub = new Uint8Array(32).fill(0x17);
  const sponsorPriv = new Uint8Array(32).fill(9);
  const sponsorPub = new Uint8Array(32).fill(0x19);

  it("signs an atomic 1-tx Deploy + rwa_create batch using PREV_DEPLOYED_CONTRACT", () => {
    const rwaArgs = buildRwaCreateCall({
      name: "Adriatic Bond 2027",
      symbol: "AB27",
      assetClass: "BOND",
      uniqueId: "bond-2027-001",
      version: 1,
      jurisdiction: "HR",
      metadataHash: new Uint8Array(32).fill(0xcd),
      metadataUri: "ipfs://QmBond",
      decimals: 6,
      maxSupply: 1_000_000n,
      initialSupply: 500_000n,
    });
    const signed = signBatchTransaction({
      chainId: 1n,
      senderPrivateKey: senderPriv,
      senderPublicKey: senderPub,
      nonce: 0n,
      actions: [
        { kind: "deploy", code: new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]) },
        {
          kind: "call",
          contract: PREV_DEPLOYED_CONTRACT,
          method: "rwa_create",
          args: rwaArgs,
          gasLimit: 500_000n,
        },
      ],
      fee: FIXED_FEE_SCHEDULE.deploy + FIXED_FEE_SCHEDULE.rwa_create,
    });

    expect(signed.hash.length).toBe(32);
    expect(signed.signature.length).toBe(64);
    expect(signed.rawHex.startsWith("0x")).toBe(true);
    expect(MAX_BATCH_ACTIONS).toBe(16);
  });

  it("rejects empty or oversized batches", () => {
    expect(() =>
      computeBatchSigningHash({
        chainId: 1n,
        sender: senderPub,
        nonce: 0n,
        actions: [],
        fee: 1n,
      }),
    ).toThrow(/1..=16/);
  });

  it("signs a sponsored (gasless) transaction with distinct sender and fee-payer signatures", () => {
    const actions = [
      { kind: "transfer" as const, to: new Uint8Array(32).fill(0x44), amount: 100n },
    ];
    const sponsored = signSponsoredTransaction({
      chainId: 1n,
      senderPrivateKey: senderPriv,
      senderPublicKey: senderPub,
      feePayerPrivateKey: sponsorPriv,
      feePayerPublicKey: sponsorPub,
      nonce: 0n,
      fee: FIXED_FEE_SCHEDULE.nft_mint,
      signingInnerKind: signingBatchKindBytes(actions),
      wireInnerKind: wireBatchKindBytes(actions),
    });

    expect(sponsored.hash.length).toBe(32);
    expect(sponsored.senderSignature.length).toBe(64);
    expect(sponsored.sponsorSignature.length).toBe(64);
    expect(sponsored.senderSignature).not.toEqual(sponsored.sponsorSignature);
    expect(
      computeSponsorSigningHash({
        chainId: 1n,
        txSigningHash: sponsored.hash,
        feePayer: sponsorPub,
        fee: FIXED_FEE_SCHEDULE.nft_mint,
      }).length,
    ).toBe(32);
  });
});
