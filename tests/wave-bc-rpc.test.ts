import { describe, expect, it } from "vitest";
import { KovanicaClient, type Transport } from "../src";

function makeMockClient(handler: (method: string, params: unknown[]) => unknown): KovanicaClient {
  const transport: Transport = {
    async send<T>(method: string, params: unknown[] = []): Promise<T> {
      return handler(method, params) as T;
    },
  };
  return new KovanicaClient({ transport });
}

describe("Wave B & C RPC Client Methods", () => {
  it("parses kovanica_getBaseFee response", async () => {
    const client = makeMockClient((method) => {
      expect(method).toBe("kovanica_getBaseFee");
      return {
        base_fee_per_byte: "0x64",
        min_base_fee_per_byte: "0x1",
        max_base_fee_per_byte: "0x186a0",
        target_block_bytes: "0x40000",
        storage_deposit_per_byte: "0x186a0",
        default_gas_price_atoms: "0x1",
      };
    });
    const info = await client.getBaseFee();
    expect(info.baseFeePerByte).toBe(100n);
    expect(info.minBaseFeePerByte).toBe(1n);
    expect(info.maxBaseFeePerByte).toBe(100_000n);
    expect(info.targetBlockBytes).toBe(262_144n);
    expect(info.storageDepositPerByte).toBe(100_000n);
    expect(info.defaultGasPriceAtoms).toBe(1n);
  });

  it("parses kovanica_getStorageDeposit response", async () => {
    const client = makeMockClient((method, params) => {
      expect(method).toBe("kovanica_getStorageDeposit");
      expect(params).toEqual(["kvnc_contract"]);
      return {
        contract: "kvnc_contract",
        bytes: "0x800",
        deposit_atoms: "0xc350000",
        deposit_per_byte: "0x186a0",
      };
    });
    const dep = await client.getStorageDeposit("kvnc_contract");
    expect(dep.bytes).toBe(2048n);
    expect(dep.depositAtoms).toBe(204_800_000n);
    expect(dep.depositPerByte).toBe(100_000n);
  });

  it("parses kovanica_getSessionKey response and null", async () => {
    const client = makeMockClient((_method, params) => {
      if (params[1] === "0x00") return null;
      return {
        owner: "kvnc_owner",
        session_pubkey: "0x22",
        allowed_contracts: ["kvnc_rwa"],
        allowed_methods: ["rwa_transfer"],
        max_spend_atoms: "0x2540be400",
        spent_atoms: "0x3b9aca00",
        expires_round: "0x7a120",
        revoked: false,
      };
    });
    const absent = await client.getSessionKey("kvnc_owner", "0x00");
    expect(absent).toBeNull();

    const policy = await client.getSessionKey("kvnc_owner", "0x22");
    expect(policy).not.toBeNull();
    expect(policy!.allowedContracts).toEqual(["kvnc_rwa"]);
    expect(policy!.allowedMethods).toEqual(["rwa_transfer"]);
    expect(policy!.maxSpendAtoms).toBe(10_000_000_000n);
    expect(policy!.spentAtoms).toBe(1_000_000_000n);
    expect(policy!.expiresRound).toBe(500_000n);
    expect(policy!.revoked).toBe(false);
  });
});
