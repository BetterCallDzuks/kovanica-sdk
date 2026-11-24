import { describe, expect, it, vi } from "vitest";
import {
  FIXED_FEE_SCHEDULE,
  KovanicaClient,
  RwaClient,
  buildRwaBurnCall,
  buildRwaCreateCall,
  buildRwaFreezeCall,
  buildRwaMintCall,
  buildRwaTransferCall,
  buildRwaUpdateMetadataCall,
} from "../src";

describe("Fixed fee schedule & KVP-106 RWA support", () => {
  it("exposes Balanced-tier fixed fee constants in atoms", () => {
    expect(FIXED_FEE_SCHEDULE.deploy).toBe(1_000_000_000n);
    expect(FIXED_FEE_SCHEDULE.token_create).toBe(5_000_000_000n);
    expect(FIXED_FEE_SCHEDULE.nft_create_collection).toBe(2_000_000_000n);
    expect(FIXED_FEE_SCHEDULE.nft_mint).toBe(100_000_000n);
    expect(FIXED_FEE_SCHEDULE.rwa_create).toBe(10_000_000_000n);
    expect(FIXED_FEE_SCHEDULE.rwa_mint).toBe(500_000_000n);
  });

  it("parses kovanica_getFeeSchedule RPC response", async () => {
    const transport = {
      send: vi.fn(async () => ({
        chain_id: "0x1",
        active_from_round: "0x0",
        active: true,
        fee_split_burn_bps: 7500,
        fee_split_miner_bps: 2500,
        fixed_fees: {
          deploy: "0x3b9aca00",
          token_create: "0x12a05f200",
          nft_create_collection: "0x77359400",
          nft_mint: "0x5f5e100",
          rwa_create: "0x2540be400",
          rwa_mint: "0x1dcd6500",
        },
      })),
    };
    const client = new KovanicaClient({ transport: transport as never });
    const schedule = await client.getFeeSchedule();
    expect(schedule.chainId).toBe(1n);
    expect(schedule.active).toBe(true);
    expect(schedule.feeSplitBurnBps).toBe(7500);
    expect(schedule.feeSplitMinerBps).toBe(2500);
    expect(schedule.fixedFees.rwaCreate).toBe(10_000_000_000n);
    expect(schedule.fixedFees.rwaMint).toBe(500_000_000n);
  });

  it("encodes KVP-106 RWA call arguments and prepares calls via RwaClient", async () => {
    const hash = new Uint8Array(32).fill(0xab);
    const recipient = new Uint8Array(32).fill(0x22);
    const contract = new Uint8Array(32).fill(0x99);

    const createArgs = buildRwaCreateCall({
      name: "Zagreb Tower 12A",
      symbol: "ZT12A",
      assetClass: "RE",
      uniqueId: "tower-12a",
      version: 1,
      jurisdiction: "HR",
      metadataHash: hash,
      metadataUri: "ipfs://QmMeta",
      legalUri: "ipfs://QmLegal",
      custodyUri: "ipfs://QmCustody",
      decimals: 6,
      maxSupply: 1_000_000n,
      initialSupply: 100_000n,
    });
    expect(createArgs.length).toBeGreaterThan(100);
    expect(buildRwaMintCall(recipient, 500n).length).toBe(48);
    expect(buildRwaTransferCall(recipient, 250n).length).toBe(48);
    expect(buildRwaBurnCall(100n).length).toBe(16);
    expect(buildRwaFreezeCall(recipient, true).length).toBe(33);
    expect(
      buildRwaUpdateMetadataCall({
        metadataHash: hash,
        metadataUri: "ipfs://new",
      }).length,
    ).toBeGreaterThan(32);

    const mockClient = {
      call: vi.fn(),
      estimateFee: vi.fn(async () => 1n),
      getNonce: vi.fn(async () => 0n),
      getStorageAt: vi.fn(async () => "0x"),
    };
    const rwa = new RwaClient(mockClient, contract);
    const prepared = await rwa.prepareMint(
      { to: recipient, amount: 500n },
      { fee: FIXED_FEE_SCHEDULE.rwa_mint },
    );
    expect(prepared.call.method).toBe("rwa_mint");
    expect(prepared.fee).toBe(500_000_000n);
  });
});
