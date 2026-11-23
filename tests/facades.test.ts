import { describe, expect, it, vi } from "vitest";
import { encodeAddress } from "../src/address";
import { CHAIN_IDS } from "../src/chains";
import { KovanicaClient } from "../src/client";
import {
  DEFAULT_CALL_GAS_LIMIT,
  buildEscrowCreateCall,
  buildHtlcCreateCall,
  buildNameRegisterCall,
  buildTokenTransferCall,
  bytesToHex,
  concatBytes,
  encodeBincodeBytes32Vec,
  encodeBincodeString,
  encodeBincodeStringVec,
  u64le,
  u128le,
} from "../src/contracts";
import { KovanicaDecodeError, deriveStorageSlotHex } from "../src/decoders";
import {
  type ContractFacadeClient,
  EscrowClient,
  HtlcClient,
  NameRegistryClient,
  TokenClient,
} from "../src/facades";

function makeBytes32(fill: number): Uint8Array {
  const buf = new Uint8Array(32);
  buf.fill(fill);
  return buf;
}

function encodeNameEntryBytes(
  owner: Uint8Array,
  pubkey: Uint8Array,
  relayEndpoints: string[],
): Uint8Array {
  return concatBytes([owner, pubkey, encodeBincodeStringVec(relayEndpoints)]);
}

function encodeTokenMetadataBytes(opts: {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  owner: Uint8Array;
  minter: Uint8Array;
  balances?: Array<{ account: Uint8Array; amount: bigint }>;
  allowances?: Array<{ owner: Uint8Array; spender: Uint8Array; amount: bigint }>;
  paused?: boolean;
  icon?: string;
}): Uint8Array {
  const balances = opts.balances ?? [];
  const allowances = opts.allowances ?? [];
  const parts: Uint8Array[] = [
    encodeBincodeString(opts.name),
    encodeBincodeString(opts.symbol),
    Uint8Array.of(opts.decimals),
    u128le(opts.totalSupply),
    opts.owner,
    opts.minter,
    u64le(BigInt(balances.length)),
  ];
  for (const b of balances) {
    parts.push(b.account, u128le(b.amount));
  }
  parts.push(u64le(BigInt(allowances.length)));
  for (const a of allowances) {
    parts.push(a.owner, a.spender, u128le(a.amount));
  }
  parts.push(Uint8Array.of(opts.paused ? 1 : 0));
  if (opts.icon !== undefined) {
    parts.push(encodeBincodeString(opts.icon));
  }
  return concatBytes(parts);
}

function encodeEscrowBytes(opts: {
  creator: Uint8Array;
  parties: Uint8Array[];
  threshold: number;
  approvals: Uint8Array[];
  amount: bigint;
  deadline: bigint;
  released: boolean;
  refunded: boolean;
}): Uint8Array {
  return concatBytes([
    opts.creator,
    encodeBincodeBytes32Vec(opts.parties),
    Uint8Array.of(opts.threshold),
    encodeBincodeBytes32Vec(opts.approvals),
    u128le(opts.amount),
    u64le(opts.deadline),
    Uint8Array.of(opts.released ? 1 : 0),
    Uint8Array.of(opts.refunded ? 1 : 0),
  ]);
}

function encodeHtlcBytes(opts: {
  sender: Uint8Array;
  claimer: Uint8Array;
  amount: bigint;
  hashLock: Uint8Array;
  expiry: bigint;
  claimed: boolean;
  refunded: boolean;
}): Uint8Array {
  return concatBytes([
    opts.sender,
    opts.claimer,
    u128le(opts.amount),
    opts.hashLock,
    u64le(opts.expiry),
    Uint8Array.of(opts.claimed ? 1 : 0),
    Uint8Array.of(opts.refunded ? 1 : 0),
  ]);
}

function createMockFacadeClient(overrides: Partial<ContractFacadeClient> = {}) {
  const call = vi.fn().mockResolvedValue("0x");
  const estimateFee = vi.fn().mockResolvedValue(10n);
  const getNonce = vi.fn().mockResolvedValue(7n);
  const getStorageAt = vi.fn().mockResolvedValue("0x");

  const client: ContractFacadeClient = {
    call: overrides.call ?? call,
    estimateFee: overrides.estimateFee ?? estimateFee,
    getNonce: overrides.getNonce ?? getNonce,
    getStorageAt: overrides.getStorageAt ?? getStorageAt,
  };

  return { client, call, estimateFee, getNonce, getStorageAt };
}

describe("Typed Contract Client Facades", () => {
  const CONTRACT_BYTES = makeBytes32(0x42);
  const CONTRACT_HEX = bytesToHex(CONTRACT_BYTES);
  const CONTRACT_ADDR = encodeAddress(CONTRACT_BYTES);
  const SENDER_ADDR = encodeAddress(makeBytes32(0x11));

  describe("Shared facade construction & validation", () => {
    it("accepts a real KovanicaClient instance as ContractFacadeClient", () => {
      const rpcClient = new KovanicaClient("http://127.0.0.1:8545");
      const nameClient = new NameRegistryClient(rpcClient, CONTRACT_ADDR);
      const tokenClient = new TokenClient(rpcClient, `0x${CONTRACT_HEX}`);
      const escrowClient = new EscrowClient(rpcClient, CONTRACT_BYTES);
      const htlcClient = new HtlcClient(rpcClient, CONTRACT_HEX);

      expect(nameClient.contractAddress).toBe(CONTRACT_ADDR);
      expect(tokenClient.contractAddress).toBe(CONTRACT_ADDR);
      expect(escrowClient.contractHex).toBe(CONTRACT_HEX);
      expect(htlcClient.contractBytes).toEqual(CONTRACT_BYTES);
    });

    it("defensively copies Uint8Array contract bytes on construction", () => {
      const { client } = createMockFacadeClient();
      const mutable = makeBytes32(0x55);
      const token = new TokenClient(client, mutable);
      mutable.fill(0x00);
      expect(token.contractBytes).toEqual(makeBytes32(0x55));
    });

    it("rejects invalid contract addresses fail-closed", () => {
      const { client } = createMockFacadeClient();
      expect(() => new NameRegistryClient(client, new Uint8Array(16))).toThrow(
        /NameRegistryClient contract/,
      );
      expect(() => new TokenClient(client, "not-a-valid-address")).toThrow(
        /TokenClient contract/,
      );
      expect(() => new EscrowClient(client, "0xdeadbeef")).toThrow(
        /EscrowClient contract/,
      );
      expect(() => new HtlcClient(client, "kvncinvalidchecksumdag")).toThrow(
        /HtlcClient contract/,
      );
    });

    it("rejects invalid client instances fail-closed", () => {
      expect(
        () => new TokenClient(null as unknown as ContractFacadeClient, CONTRACT_ADDR),
      ).toThrow(TypeError);
      expect(
        () => new TokenClient({} as unknown as ContractFacadeClient, CONTRACT_ADDR),
      ).toThrow(/call, estimateFee, getNonce, and getStorageAt/);
    });
  });

  describe("NameRegistryClient", () => {
    const owner = makeBytes32(0xaa);
    const pubkey = makeBytes32(0xbb);
    const relays = ["https://relay1.kovanica.org", "https://relay2.kovanica.org"];
    const encodedRecord = encodeNameEntryBytes(owner, pubkey, relays);

    it("resolve() executes name_resolve via dryRunCall and decodes NameRecord", async () => {
      const { client, call } = createMockFacadeClient();
      call.mockResolvedValueOnce(`0x${bytesToHex(encodedRecord)}`);

      const registry = new NameRegistryClient(client, CONTRACT_ADDR);
      const record = await registry.resolve("  alice  ", {
        from: SENDER_ADDR,
        gasLimit: 50_000n,
      });

      expect(record.owner).toEqual(owner);
      expect(record.ownerHex).toBe(bytesToHex(owner));
      expect(record.pubkey).toEqual(pubkey);
      expect(record.pubkeyHex).toBe(bytesToHex(pubkey));
      expect(record.relayEndpoints).toEqual(relays);

      expect(call).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledWith(
        "kovanica_call",
        [
          {
            to: CONTRACT_ADDR,
            from: SENDER_ADDR,
            entry: "name_resolve",
            method: "name_resolve",
            data: `0x${bytesToHex(encodeBincodeString("alice"))}`,
            value: "0x0",
            gas: "0xc350",
          },
        ],
        undefined,
      );
    });

    it("resolve() rejects empty name before RPC and surfaces KovanicaDecodeError on malformed payload", async () => {
      const { client, call } = createMockFacadeClient();
      const registry = new NameRegistryClient(client, CONTRACT_ADDR);

      await expect(registry.resolve("   ")).rejects.toThrow(/non-empty string/);
      expect(call).not.toHaveBeenCalled();

      call.mockResolvedValueOnce("0xdeadbeef");
      await expect(registry.resolve("alice")).rejects.toThrow(KovanicaDecodeError);
    });

    it("getRecord() reads canonical name storage slot and decodes NameRecord", async () => {
      const { client, getStorageAt } = createMockFacadeClient();
      getStorageAt.mockResolvedValueOnce(`0x${bytesToHex(encodedRecord)}`);

      const registry = new NameRegistryClient(client, CONTRACT_ADDR);
      const record = await registry.getRecord("Alice");

      expect(record).not.toBeNull();
      expect(record!.ownerHex).toBe(bytesToHex(owner));
      expect(record!.pubkeyHex).toBe(bytesToHex(pubkey));
      expect(record!.relayEndpoints).toEqual(relays);

      const expectedSlot = `0x${deriveStorageSlotHex("name", "Alice")}`;
      expect(getStorageAt).toHaveBeenCalledWith(CONTRACT_ADDR, expectedSlot, undefined);
    });

    it("getRecord() returns null on empty storage and rejects empty name", async () => {
      const { client, getStorageAt } = createMockFacadeClient();
      getStorageAt.mockResolvedValueOnce("0x");

      const registry = new NameRegistryClient(client, CONTRACT_ADDR);
      expect(await registry.getRecord("unregistered")).toBeNull();

      await expect(registry.getRecord("")).rejects.toThrow(/non-empty string/);
      expect(getStorageAt).toHaveBeenCalledTimes(1);
    });

    it("prepareRegister() builds canonical name_register call and estimates fee/nonce", async () => {
      const { client, estimateFee, getNonce } = createMockFacadeClient();
      estimateFee.mockResolvedValueOnce(25n);
      getNonce.mockResolvedValueOnce(12n);

      const registry = new NameRegistryClient(client, CONTRACT_ADDR);
      const prepared = await registry.prepareRegister(
        {
          name: "alice",
          pubkey: encodeAddress(pubkey),
          relayEndpoints: relays,
        },
        {
          sender: SENDER_ADDR,
          chainId: CHAIN_IDS.TESTNET,
        },
      );

      expect(prepared.call.method).toBe("name_register");
      expect(prepared.call.contract).toEqual(CONTRACT_BYTES);
      expect(prepared.call.args).toEqual(buildNameRegisterCall("alice", pubkey, relays));
      // Default gas limit (100_000n) gets +20% default gas safety margin -> 120_000n
      expect(prepared.gasLimit).toBe((DEFAULT_CALL_GAS_LIMIT * 12_000n) / 10_000n);
      expect(prepared.nonce).toBe(12n);
      expect(prepared.feeRatePerByte).toBe(25n);
      expect(prepared.fee).toBeGreaterThan(0n);
      expect(prepared.chainId).toBe(CHAIN_IDS.TESTNET);
      expect(estimateFee).toHaveBeenCalledTimes(1);
      expect(getNonce).toHaveBeenCalledWith(SENDER_ADDR, undefined);
    });

    it("prepareRegister() validates inputs fail-closed before RPC", async () => {
      const { client, estimateFee, getNonce } = createMockFacadeClient();
      const registry = new NameRegistryClient(client, CONTRACT_ADDR);

      await expect(
        registry.prepareRegister({ name: "", pubkey }),
      ).rejects.toThrow(/non-empty string/);
      await expect(
        registry.prepareRegister({ name: "alice", pubkey: "0x1234" }),
      ).rejects.toThrow(/pubkey/);
      await expect(
        registry.prepareRegister({
          name: "alice",
          pubkey,
          relayEndpoints: [123 as unknown as string],
        }),
      ).rejects.toThrow(TypeError);

      expect(estimateFee).not.toHaveBeenCalled();
      expect(getNonce).not.toHaveBeenCalled();
    });
  });

  describe("TokenClient", () => {
    const owner = makeBytes32(0x10);
    const minter = makeBytes32(0x20);
    const holder = makeBytes32(0x30);
    const recipient = makeBytes32(0x40);

    it("getMetadata() reads canonical token_metadata storage and decodes TokenMetadata", async () => {
      const { client, getStorageAt } = createMockFacadeClient();
      const payload = encodeTokenMetadataBytes({
        name: "Kovanica USD",
        symbol: "KUSD",
        decimals: 6,
        totalSupply: 1_000_000_000n,
        owner,
        minter,
        balances: [{ account: holder, amount: 500_000n }],
        paused: false,
        icon: "https://example.com/kusd.svg",
      });
      getStorageAt.mockResolvedValueOnce(`0x${bytesToHex(payload)}`);

      const token = new TokenClient(client, CONTRACT_ADDR);
      const metadata = await token.getMetadata();

      expect(metadata).not.toBeNull();
      expect(metadata!.name).toBe("Kovanica USD");
      expect(metadata!.symbol).toBe("KUSD");
      expect(metadata!.decimals).toBe(6);
      expect(metadata!.totalSupply).toBe(1_000_000_000n);
      expect(metadata!.ownerHex).toBe(bytesToHex(owner));
      expect(metadata!.minterHex).toBe(bytesToHex(minter));
      expect(metadata!.balances).toHaveLength(1);
      expect(metadata!.balances[0]!.amount).toBe(500_000n);
      expect(metadata!.icon).toBe("https://example.com/kusd.svg");

      const expectedSlot = `0x${deriveStorageSlotHex("token")}`;
      expect(getStorageAt).toHaveBeenCalledWith(CONTRACT_ADDR, expectedSlot, undefined);
    });

    it("getMetadata() returns null when storage slot is empty", async () => {
      const { client, getStorageAt } = createMockFacadeClient();
      getStorageAt.mockResolvedValueOnce(`0x${"00".repeat(32)}`);

      const token = new TokenClient(client, CONTRACT_ADDR);
      expect(await token.getMetadata()).toBeNull();
    });

    it("prepareTransfer() builds canonical token_transfer call and estimates fee/nonce", async () => {
      const { client, estimateFee, getNonce } = createMockFacadeClient();
      estimateFee.mockResolvedValueOnce(15n);
      getNonce.mockResolvedValueOnce(3n);

      const token = new TokenClient(client, CONTRACT_ADDR);
      const prepared = await token.prepareTransfer(
        {
          recipient: encodeAddress(recipient),
          amount: 250_000n,
          gasLimit: 80_000n,
        },
        { sender: SENDER_ADDR },
      );

      const expectedBuilt = buildTokenTransferCall(CONTRACT_BYTES, recipient, 250_000n);
      expect(prepared.call.method).toBe("token_transfer");
      expect(prepared.call.args).toEqual(expectedBuilt.args);
      expect(prepared.gasLimit).toBe(80_000n);
      expect(prepared.nonce).toBe(3n);
      expect(prepared.feeRatePerByte).toBe(15n);
      expect(prepared.fee).toBeGreaterThan(0n);
    });

    it("prepareTransfer() rejects invalid recipient and negative amount fail-closed", async () => {
      const { client, estimateFee, getNonce } = createMockFacadeClient();
      const token = new TokenClient(client, CONTRACT_ADDR);

      await expect(
        token.prepareTransfer({ recipient: "bad-address", amount: 10n }),
      ).rejects.toThrow(/recipient/);
      await expect(
        token.prepareTransfer({ recipient, amount: -1n }),
      ).rejects.toThrow(RangeError);

      expect(estimateFee).not.toHaveBeenCalled();
      expect(getNonce).not.toHaveBeenCalled();
    });
  });

  describe("EscrowClient", () => {
    const escrowId = makeBytes32(0x77);
    const partyA = makeBytes32(0x01);
    const partyB = makeBytes32(0x02);
    const partyC = makeBytes32(0x03);

    it("getEscrow() reads canonical escrow storage slot and decodes EscrowRecord", async () => {
      const { client, getStorageAt } = createMockFacadeClient();
      const payload = encodeEscrowBytes({
        creator: partyA,
        parties: [partyA, partyB, partyC],
        threshold: 2,
        approvals: [partyA],
        amount: 5_000_000n,
        deadline: 1_800_000_000n,
        released: false,
        refunded: false,
      });
      getStorageAt.mockResolvedValueOnce(`0x${bytesToHex(payload)}`);

      const escrow = new EscrowClient(client, CONTRACT_ADDR);
      const record = await escrow.getEscrow(`0x${bytesToHex(escrowId)}`);

      expect(record).not.toBeNull();
      expect(record!.creatorHex).toBe(bytesToHex(partyA));
      expect(record!.partiesHex).toEqual([
        bytesToHex(partyA),
        bytesToHex(partyB),
        bytesToHex(partyC),
      ]);
      expect(record!.threshold).toBe(2);
      expect(record!.approvalsHex).toEqual([bytesToHex(partyA)]);
      expect(record!.amount).toBe(5_000_000n);
      expect(record!.deadline).toBe(1_800_000_000n);
      expect(record!.status).toBe("open");

      const expectedSlot = `0x${deriveStorageSlotHex("escrow", escrowId)}`;
      expect(getStorageAt).toHaveBeenCalledWith(CONTRACT_ADDR, expectedSlot, undefined);
    });

    it("getEscrow() returns null on empty storage and rejects invalid id", async () => {
      const { client, getStorageAt } = createMockFacadeClient();
      getStorageAt.mockResolvedValueOnce("0x0");

      const escrow = new EscrowClient(client, CONTRACT_ADDR);
      expect(await escrow.getEscrow(escrowId)).toBeNull();

      await expect(escrow.getEscrow("0x1234")).rejects.toThrow(/EscrowClient\.getEscrow id/);
      expect(getStorageAt).toHaveBeenCalledTimes(1);
    });

    it("prepareCreate() builds canonical escrow_create call and estimates fee/nonce", async () => {
      const { client, estimateFee, getNonce } = createMockFacadeClient();
      estimateFee.mockResolvedValueOnce(20n);
      getNonce.mockResolvedValueOnce(9n);

      const escrow = new EscrowClient(client, CONTRACT_ADDR);
      const prepared = await escrow.prepareCreate(
        {
          parties: [encodeAddress(partyA), `0x${bytesToHex(partyB)}`, partyC],
          threshold: 2,
          amount: 5_000_000n,
          deadline: 1_800_000_000n,
          value: 5_000_000n,
        },
        { sender: SENDER_ADDR },
      );

      expect(prepared.call.method).toBe("escrow_create");
      expect(prepared.call.call_value).toBe(5_000_000n);
      expect(prepared.call.args).toEqual(
        buildEscrowCreateCall([partyA, partyB, partyC], 2, 5_000_000n, 1_800_000_000n),
      );
      expect(prepared.nonce).toBe(9n);
      expect(prepared.feeRatePerByte).toBe(20n);
    });

    it("prepareCreate() rejects invalid parties/threshold fail-closed before RPC", async () => {
      const { client, estimateFee, getNonce } = createMockFacadeClient();
      const escrow = new EscrowClient(client, CONTRACT_ADDR);

      await expect(
        escrow.prepareCreate({ parties: [], threshold: 1, amount: 100n, deadline: 1000n }),
      ).rejects.toThrow(/non-empty array/);
      await expect(
        escrow.prepareCreate({
          parties: [partyA],
          threshold: 2,
          amount: 100n,
          deadline: 1000n,
        }),
      ).rejects.toThrow(/Threshold cannot exceed/);
      await expect(
        escrow.prepareCreate({
          parties: ["invalid-party"],
          threshold: 1,
          amount: 100n,
          deadline: 1000n,
        }),
      ).rejects.toThrow(/parties\[0\]/);

      expect(estimateFee).not.toHaveBeenCalled();
      expect(getNonce).not.toHaveBeenCalled();
    });
  });

  describe("HtlcClient", () => {
    const swapId = makeBytes32(0x88);
    const sender = makeBytes32(0x12);
    const claimer = makeBytes32(0x34);
    const hashlock = makeBytes32(0x99);

    it("getHtlc() reads canonical htlc storage slot and decodes HtlcRecord", async () => {
      const { client, getStorageAt } = createMockFacadeClient();
      const payload = encodeHtlcBytes({
        sender,
        claimer,
        amount: 10_000_000n,
        hashLock: hashlock,
        expiry: 1_900_000_000n,
        claimed: true,
        refunded: false,
      });
      getStorageAt.mockResolvedValueOnce(`0x${bytesToHex(payload)}`);

      const htlc = new HtlcClient(client, CONTRACT_ADDR);
      const record = await htlc.getHtlc(swapId);

      expect(record).not.toBeNull();
      expect(record!.senderHex).toBe(bytesToHex(sender));
      expect(record!.claimerHex).toBe(bytesToHex(claimer));
      expect(record!.amount).toBe(10_000_000n);
      expect(record!.hashLockHex).toBe(bytesToHex(hashlock));
      expect(record!.expiry).toBe(1_900_000_000n);
      expect(record!.claimed).toBe(true);
      expect(record!.refunded).toBe(false);
      expect(record!.status).toBe("claimed");

      const expectedSlot = `0x${deriveStorageSlotHex("htlc", swapId)}`;
      expect(getStorageAt).toHaveBeenCalledWith(CONTRACT_ADDR, expectedSlot, undefined);
    });

    it("getHtlc() returns null on empty storage and rejects invalid id", async () => {
      const { client, getStorageAt } = createMockFacadeClient();
      getStorageAt.mockResolvedValueOnce("0x");

      const htlc = new HtlcClient(client, CONTRACT_ADDR);
      expect(await htlc.getHtlc(`0x${bytesToHex(swapId)}`)).toBeNull();

      await expect(htlc.getHtlc(new Uint8Array(8))).rejects.toThrow(/HtlcClient\.getHtlc id/);
      expect(getStorageAt).toHaveBeenCalledTimes(1);
    });

    it("prepareCreate() builds canonical htlc_create call and estimates fee/nonce", async () => {
      const { client, estimateFee, getNonce } = createMockFacadeClient();
      estimateFee.mockResolvedValueOnce(30n);
      getNonce.mockResolvedValueOnce(4n);

      const htlc = new HtlcClient(client, CONTRACT_ADDR);
      const prepared = await htlc.prepareCreate(
        {
          hashlock: `0x${bytesToHex(hashlock)}`,
          timelock: 1_900_000_000n,
          recipient: encodeAddress(claimer),
          value: 10_000_000n,
        },
        { sender: SENDER_ADDR, nonce: 42n },
      );

      expect(prepared.call.method).toBe("htlc_create");
      expect(prepared.call.call_value).toBe(10_000_000n);
      expect(prepared.call.args).toEqual(
        buildHtlcCreateCall(hashlock, 1_900_000_000n, claimer),
      );
      expect(prepared.call.args.length).toBe(72);
      expect(prepared.nonce).toBe(42n);
      expect(prepared.feeRatePerByte).toBe(30n);
      // Explicit nonce skips getNonce RPC
      expect(getNonce).not.toHaveBeenCalled();
    });

    it("prepareCreate() rejects invalid hashlock, recipient, and negative timelock fail-closed", async () => {
      const { client, estimateFee, getNonce } = createMockFacadeClient();
      const htlc = new HtlcClient(client, CONTRACT_ADDR);

      await expect(
        htlc.prepareCreate({ hashlock: "0xabcd", timelock: 100n, recipient: claimer }),
      ).rejects.toThrow(/hashlock/);
      await expect(
        htlc.prepareCreate({ hashlock, timelock: 100n, recipient: "invalid-recipient" }),
      ).rejects.toThrow(/recipient/);
      await expect(
        htlc.prepareCreate({ hashlock, timelock: -5n, recipient: claimer }),
      ).rejects.toThrow(/Timelock must be non-negative/);

      expect(estimateFee).not.toHaveBeenCalled();
      expect(getNonce).not.toHaveBeenCalled();
    });
  });
});
