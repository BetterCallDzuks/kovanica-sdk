import { blake3 } from "@noble/hashes/blake3.js";
import { describe, expect, it } from "vitest";
import {
  BincodeReader,
  KovanicaDecodeError,
  KovanicaError,
  STORAGE_KEY_PREFIXES,
  bytesToHex,
  concatBytes,
  decodeContractLog,
  decodeEscrowRecord,
  decodeHtlcRecord,
  decodeMultisigPendingTx,
  decodeMultisigState,
  decodeNameRecord,
  decodeNftMetadata,
  decodeNftState,
  decodeTokenMetadata,
  decodeTokenPool,
  decodeTokenState,
  decodeVaultRecord,
  derivePrefixedStorageSlot,
  deriveStorageSlot,
  deriveStorageSlotHex,
  encodeBincodeBytes32Vec,
  encodeBincodeString,
  encodeBincodeStringVec,
  u32le,
  u64le,
  u128le,
} from "../src/index";

function u16le(val: number): Uint8Array {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, val, true);
  return buf;
}

function bincodeBytes(data: Uint8Array): Uint8Array {
  return concatBytes([u64le(BigInt(data.length)), data]);
}

function addr(fill: number): Uint8Array {
  const buf = new Uint8Array(32);
  buf.fill(fill);
  buf[0] = fill;
  buf[31] = (fill ^ 0x5a) & 0xff;
  return buf;
}

function expectDecodeError(fn: () => unknown, code: string): KovanicaDecodeError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(KovanicaDecodeError);
    expect(err).toBeInstanceOf(KovanicaError);
    expect(err).toBeInstanceOf(Error);
    const decodeErr = err as KovanicaDecodeError;
    expect(decodeErr.code).toBe(code);
    return decodeErr;
  }
  throw new Error(`Expected KovanicaDecodeError(${code}), but function did not throw`);
}

describe("BincodeReader", () => {
  it("reads primitive little-endian integers, bools, fixed bytes, bytes, strings, options, and vecs", () => {
    const rawPayload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const fixed = addr(0x33);
    const u128Max = (1n << 128n) - 1n;

    const encoded = concatBytes([
      Uint8Array.of(0x7f), // u8
      u16le(0x1234), // u16
      u32le(0x89abcdef), // u32
      u64le(0x0102030405060708n), // u64
      u128le(u128Max), // u128
      Uint8Array.of(0), // bool false
      Uint8Array.of(1), // bool true
      fixed, // fixed 32
      bincodeBytes(rawPayload), // bytes
      encodeBincodeString("Kovanica — 🚀"), // utf8 string
      Uint8Array.of(0), // Option::None
      Uint8Array.of(1),
      u64le(999n), // Option::Some(999)
      u64le(2n),
      u32le(10),
      u32le(20), // Vec<u32>
    ]);

    // Also test non-zero byteOffset subarray view
    const padded = concatBytes([new Uint8Array([0xff, 0xff, 0xff]), encoded, new Uint8Array([0xee])]);
    const view = padded.subarray(3, 3 + encoded.length);

    const reader = new BincodeReader(view);
    expect(reader.offset).toBe(0);
    expect(reader.remaining).toBe(encoded.length);
    expect(reader.isEof()).toBe(false);

    expect(reader.readU8()).toBe(0x7f);
    expect(reader.readU16()).toBe(0x1234);
    expect(reader.readU32()).toBe(0x89abcdef);
    expect(reader.readU64()).toBe(0x0102030405060708n);
    expect(reader.readU128()).toBe(u128Max);
    expect(reader.readBool()).toBe(false);
    expect(reader.readBool()).toBe(true);
    const readFixed = reader.readFixedBytes(32);
    expect(readFixed).toEqual(fixed);
    // Ensure returned slice is detached from underlying buffer
    readFixed[0] ^= 0xff;
    expect(view[32]).not.toBe(readFixed[0]);

    expect(reader.readBytes()).toEqual(rawPayload);
    expect(reader.readString()).toBe("Kovanica — 🚀");
    expect(reader.readOption(() => reader.readU64())).toBeNull();
    expect(reader.readOption(() => reader.readU64())).toBe(999n);
    expect(reader.readVec(() => reader.readU32())).toEqual([10, 20]);

    expect(reader.isEof()).toBe(true);
    expect(reader.remaining).toBe(0);
    expect(() => reader.assertEof()).not.toThrow();
  });

  it("fails closed on truncated reads, invalid bools, invalid UTF-8, length overflows, and trailing bytes", () => {
    expectDecodeError(() => new BincodeReader(new Uint8Array(0)).readU8(), "TRUNCATED");
    expectDecodeError(() => new BincodeReader(new Uint8Array(3)).readU32(), "TRUNCATED");
    expectDecodeError(() => new BincodeReader(new Uint8Array(7)).readU64(), "TRUNCATED");
    expectDecodeError(() => new BincodeReader(new Uint8Array(15)).readU128(), "TRUNCATED");
    expectDecodeError(() => new BincodeReader(new Uint8Array(4)).readFixedBytes(5), "TRUNCATED");
    expectDecodeError(() => new BincodeReader(new Uint8Array(4)).readFixedBytes(-1), "INVALID_INPUT");

    expectDecodeError(() => new BincodeReader(Uint8Array.of(2)).readBool(), "INVALID_BOOL");
    expectDecodeError(() => new BincodeReader(Uint8Array.of(0xff)).readBool(), "INVALID_BOOL");

    expectDecodeError(() => new BincodeReader(Uint8Array.of(2)).readOption(() => 0), "INVALID_VARIANT");

    // Malicious u64::MAX length prefix must not OOM or overflow
    const maxU64 = u64le(0xffffffffffffffffn);
    expectDecodeError(() => new BincodeReader(maxU64).readBytes(), "LENGTH_OVERFLOW");
    expectDecodeError(() => new BincodeReader(maxU64).readVec(() => 0), "LENGTH_OVERFLOW");

    // Length prefix exceeding remaining buffer
    const shortBytes = concatBytes([u64le(10n), new Uint8Array([1, 2, 3])]);
    expectDecodeError(() => new BincodeReader(shortBytes).readBytes(), "TRUNCATED");

    // Invalid UTF-8 sequence
    const invalidUtf8 = bincodeBytes(new Uint8Array([0xff, 0xfe, 0x80]));
    expectDecodeError(() => new BincodeReader(invalidUtf8).readString(), "INVALID_UTF8");

    // Trailing bytes
    const withTrailing = new Uint8Array([1, 2]);
    const reader = new BincodeReader(withTrailing);
    expect(reader.readU8()).toBe(1);
    expectDecodeError(() => reader.assertEof("test"), "TRAILING_BYTES");
  });
});

describe("Canonical Contract State & Record Decoders", () => {
  describe("decodeHtlcRecord", () => {
    function encodeHtlc(params: {
      sender: Uint8Array;
      claimer: Uint8Array;
      amount: bigint;
      hashLock: Uint8Array;
      expiry: bigint;
      claimed: boolean;
      refunded: boolean;
    }): Uint8Array {
      return concatBytes([
        params.sender,
        params.claimer,
        u128le(params.amount),
        params.hashLock,
        u64le(params.expiry),
        Uint8Array.of(params.claimed ? 1 : 0),
        Uint8Array.of(params.refunded ? 1 : 0),
      ]);
    }

    it("round-trips open, claimed, and refunded HTLC records (Uint8Array and hex)", () => {
      const sender = addr(0x01);
      const claimer = addr(0x02);
      const hashLock = blake3(new TextEncoder().encode("secret-preimage"));
      const amount = 250_000_000_000n;
      const expiry = 1_500_000n;

      const openBytes = encodeHtlc({
        sender,
        claimer,
        amount,
        hashLock,
        expiry,
        claimed: false,
        refunded: false,
      });
      expect(openBytes.length).toBe(122);

      const decoded = decodeHtlcRecord(openBytes);
      expect(decoded.sender).toEqual(sender);
      expect(decoded.senderHex).toBe(bytesToHex(sender));
      expect(decoded.claimer).toEqual(claimer);
      expect(decoded.claimerHex).toBe(bytesToHex(claimer));
      expect(decoded.amount).toBe(amount);
      expect(decoded.hashLock).toEqual(hashLock);
      expect(decoded.hashLockHex).toBe(bytesToHex(hashLock));
      expect(decoded.expiry).toBe(expiry);
      expect(decoded.claimed).toBe(false);
      expect(decoded.refunded).toBe(false);
      expect(decoded.status).toBe("open");

      // Hex string with 0x prefix
      expect(decodeHtlcRecord(`0x${bytesToHex(openBytes)}`)).toEqual(decoded);

      const claimedDecoded = decodeHtlcRecord(
        encodeHtlc({ sender, claimer, amount, hashLock, expiry, claimed: true, refunded: false }),
      );
      expect(claimedDecoded.status).toBe("claimed");
      expect(claimedDecoded.claimed).toBe(true);

      const refundedDecoded = decodeHtlcRecord(
        encodeHtlc({ sender, claimer, amount, hashLock, expiry, claimed: false, refunded: true }),
      );
      expect(refundedDecoded.status).toBe("refunded");
      expect(refundedDecoded.refunded).toBe(true);
    });

    it("rejects truncated, trailing, invalid-bool, invalid-hex, and contradictory HTLC records", () => {
      const valid = encodeHtlc({
        sender: addr(1),
        claimer: addr(2),
        amount: 100n,
        hashLock: addr(3),
        expiry: 500n,
        claimed: false,
        refunded: false,
      });

      expectDecodeError(() => decodeHtlcRecord(valid.slice(0, 121)), "TRUNCATED");
      expectDecodeError(() => decodeHtlcRecord(concatBytes([valid, Uint8Array.of(0)])), "TRAILING_BYTES");
      expectDecodeError(() => decodeHtlcRecord("0xzz"), "INVALID_INPUT");

      const badBool = valid.slice();
      badBool[120] = 2;
      expectDecodeError(() => decodeHtlcRecord(badBool), "INVALID_BOOL");

      const bothTrue = encodeHtlc({
        sender: addr(1),
        claimer: addr(2),
        amount: 100n,
        hashLock: addr(3),
        expiry: 500n,
        claimed: true,
        refunded: true,
      });
      expectDecodeError(() => decodeHtlcRecord(bothTrue), "INVALID_INPUT");
    });
  });

  describe("decodeVaultRecord", () => {
    it("round-trips Absolute, Linear (no cliff), and Linear (with cliff) vault records", () => {
      const creator = addr(0x10);
      const beneficiary = addr(0x20);
      const total = 1_000_000_000n;
      const claimed = 250_000_000n;

      // Absolute schedule (variant 0)
      const absBytes = concatBytes([
        creator,
        beneficiary,
        u128le(total),
        u128le(claimed),
        u32le(0),
        u64le(500_000n),
        Uint8Array.of(0),
      ]);
      const abs = decodeVaultRecord(absBytes);
      expect(abs.creator).toEqual(creator);
      expect(abs.beneficiary).toEqual(beneficiary);
      expect(abs.totalAmount).toBe(total);
      expect(abs.claimedAmount).toBe(claimed);
      expect(abs.schedule).toEqual({ kind: "absolute", unlockAt: 500_000n });
      expect(abs.startHeight).toBe(500_000n);
      expect(abs.cliffHeight).toBeNull();
      expect(abs.endHeight).toBe(500_000n);
      expect(abs.cancelled).toBe(false);

      // Linear without cliff (variant 1, Option::None = 0)
      const linNoCliffBytes = concatBytes([
        creator,
        beneficiary,
        u128le(total),
        u128le(0n),
        u32le(1),
        u64le(100n),
        u64le(1_000n),
        Uint8Array.of(0),
        Uint8Array.of(1),
      ]);
      const linNoCliff = decodeVaultRecord(linNoCliffBytes);
      expect(linNoCliff.schedule).toEqual({
        kind: "linear",
        start: 100n,
        end: 1_000n,
        cliff: null,
      });
      expect(linNoCliff.startHeight).toBe(100n);
      expect(linNoCliff.cliffHeight).toBeNull();
      expect(linNoCliff.endHeight).toBe(1_000n);
      expect(linNoCliff.cancelled).toBe(true);

      // Linear with cliff (variant 1, Option::Some = 1 + u64)
      const linCliffBytes = concatBytes([
        creator,
        beneficiary,
        u128le(total),
        u128le(claimed),
        u32le(1),
        u64le(100n),
        u64le(1_000n),
        Uint8Array.of(1),
        u64le(300n),
        Uint8Array.of(0),
      ]);
      const linCliff = decodeVaultRecord(linCliffBytes);
      expect(linCliff.schedule).toEqual({
        kind: "linear",
        start: 100n,
        end: 1_000n,
        cliff: 300n,
      });
      expect(linCliff.startHeight).toBe(100n);
      expect(linCliff.cliffHeight).toBe(300n);
      expect(linCliff.endHeight).toBe(1_000n);
      expect(linCliff.cancelled).toBe(false);
    });

    it("rejects unknown schedule variant, invalid cliff option tag, truncation, and trailing bytes", () => {
      const base = concatBytes([addr(1), addr(2), u128le(100n), u128le(0n)]);

      const badVariant = concatBytes([base, u32le(2), u64le(10n), Uint8Array.of(0)]);
      expectDecodeError(() => decodeVaultRecord(badVariant), "INVALID_VARIANT");

      const badCliffTag = concatBytes([base, u32le(1), u64le(10n), u64le(20n), Uint8Array.of(2), Uint8Array.of(0)]);
      expectDecodeError(() => decodeVaultRecord(badCliffTag), "INVALID_VARIANT");

      const validAbs = concatBytes([base, u32le(0), u64le(10n), Uint8Array.of(0)]);
      expectDecodeError(() => decodeVaultRecord(validAbs.slice(0, -1)), "TRUNCATED");
      expectDecodeError(() => decodeVaultRecord(concatBytes([validAbs, Uint8Array.of(0)])), "TRAILING_BYTES");
    });
  });

  describe("decodeMultisigState & decodeMultisigPendingTx", () => {
    it("round-trips MultisigState and rejects malformed buffers", () => {
      const owners = [addr(0x01), addr(0x02), addr(0x03)];
      const bytes = concatBytes([encodeBincodeBytes32Vec(owners), u32le(2), u64le(7n)]);

      const state = decodeMultisigState(bytes);
      expect(state.owners).toEqual(owners);
      expect(state.ownersHex).toEqual(owners.map(bytesToHex));
      expect(state.threshold).toBe(2);
      expect(state.nextTxId).toBe(7n);

      expectDecodeError(() => decodeMultisigState(bytes.slice(0, -1)), "TRUNCATED");
      expectDecodeError(() => decodeMultisigState(concatBytes([bytes, Uint8Array.of(0)])), "TRAILING_BYTES");
      expectDecodeError(() => decodeMultisigState(u64le(5_000n)), "LENGTH_OVERFLOW");
    });

    it("round-trips MultisigPendingTx and rejects malformed buffers", () => {
      const to = addr(0xaa);
      const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
      const confs = [addr(0x01), addr(0x02)];
      const bytes = concatBytes([
        u64le(42n),
        to,
        u128le(9_999_999n),
        bincodeBytes(data),
        encodeBincodeBytes32Vec(confs),
        Uint8Array.of(1),
      ]);

      const tx = decodeMultisigPendingTx(bytes);
      expect(tx.id).toBe(42n);
      expect(tx.to).toEqual(to);
      expect(tx.toHex).toBe(bytesToHex(to));
      expect(tx.amount).toBe(9_999_999n);
      expect(tx.data).toEqual(data);
      expect(tx.dataHex).toBe("01020304");
      expect(tx.confirmations).toEqual(confs);
      expect(tx.confirmationsHex).toEqual(confs.map(bytesToHex));
      expect(tx.executed).toBe(true);

      expectDecodeError(() => decodeMultisigPendingTx(bytes.slice(0, -1)), "TRUNCATED");
      expectDecodeError(() => decodeMultisigPendingTx(concatBytes([bytes, Uint8Array.of(0)])), "TRAILING_BYTES");

      const badExec = bytes.slice();
      badExec[badExec.length - 1] = 9;
      expectDecodeError(() => decodeMultisigPendingTx(badExec), "INVALID_BOOL");
    });
  });

  describe("decodeTokenMetadata & decodeTokenPool", () => {
    it("round-trips v2 Token (with icon) and v1 Token (pre-icon) layouts", () => {
      const owner = addr(0x01);
      const minter = addr(0x02);
      const holder = addr(0x03);
      const spender = addr(0x04);

      const v1Bytes = concatBytes([
        encodeBincodeString("Kovanica USD"),
        encodeBincodeString("KUSD"),
        Uint8Array.of(6),
        u128le(1_000_000_000_000n),
        owner,
        minter,
        // balances (1 entry)
        u64le(1n),
        holder,
        u128le(500_000_000n),
        // allowances (1 entry)
        u64le(1n),
        holder,
        spender,
        u128le(100_000n),
        // paused
        Uint8Array.of(0),
      ]);

      const v1 = decodeTokenMetadata(v1Bytes);
      expect(v1.name).toBe("Kovanica USD");
      expect(v1.symbol).toBe("KUSD");
      expect(v1.decimals).toBe(6);
      expect(v1.totalSupply).toBe(1_000_000_000_000n);
      expect(v1.owner).toEqual(owner);
      expect(v1.minter).toEqual(minter);
      expect(v1.balances).toHaveLength(1);
      expect(v1.balances[0]).toEqual({
        account: holder,
        accountHex: bytesToHex(holder),
        amount: 500_000_000n,
      });
      expect(v1.allowances).toHaveLength(1);
      expect(v1.allowances[0]).toEqual({
        owner: holder,
        ownerHex: bytesToHex(holder),
        spender,
        spenderHex: bytesToHex(spender),
        amount: 100_000n,
      });
      expect(v1.paused).toBe(false);
      expect(v1.icon).toBe("");
      expect(decodeTokenState(v1Bytes)).toEqual(v1);

      const v2Bytes = concatBytes([v1Bytes, encodeBincodeString("https://kovanica.org/kusd.png")]);
      const v2 = decodeTokenMetadata(v2Bytes);
      expect(v2.icon).toBe("https://kovanica.org/kusd.png");

      // Trailing garbage after v2 icon must fail closed
      expectDecodeError(() => decodeTokenMetadata(concatBytes([v2Bytes, Uint8Array.of(0xff)])), "TRAILING_BYTES");
      // Trailing single byte after v1 (truncated icon length) must fail closed
      expectDecodeError(() => decodeTokenMetadata(concatBytes([v1Bytes, Uint8Array.of(0x01)])), "TRUNCATED");
      // Truncated before paused
      expectDecodeError(() => decodeTokenMetadata(v1Bytes.slice(0, -1)), "TRUNCATED");
    });

    it("round-trips TokenPool state and rejects malformed buffers", () => {
      const poolBytes = concatBytes([
        u128le(10_000_000_000n),
        u128le(50_000_000_000n),
        u16le(30),
        u128le(22_360_679_774n),
        Uint8Array.of(1),
      ]);
      expect(poolBytes.length).toBe(51);

      const pool = decodeTokenPool(poolBytes);
      expect(pool.kunaReserve).toBe(10_000_000_000n);
      expect(pool.tokenReserve).toBe(50_000_000_000n);
      expect(pool.feeBps).toBe(30);
      expect(pool.lpTotal).toBe(22_360_679_774n);
      expect(pool.paused).toBe(true);

      expectDecodeError(() => decodeTokenPool(poolBytes.slice(0, 50)), "TRUNCATED");
      expectDecodeError(() => decodeTokenPool(concatBytes([poolBytes, Uint8Array.of(0)])), "TRAILING_BYTES");
    });
  });

  describe("decodeNameRecord", () => {
    it("round-trips NameEntry records and rejects malformed buffers", () => {
      const owner = addr(0x41);
      const pubkey = addr(0x42);
      const endpoints = ["https://relay1.kovanica.org", "https://relay2.kovanica.org"];
      const bytes = concatBytes([owner, pubkey, encodeBincodeStringVec(endpoints)]);

      const record = decodeNameRecord(bytes);
      expect(record.owner).toEqual(owner);
      expect(record.ownerHex).toBe(bytesToHex(owner));
      expect(record.pubkey).toEqual(pubkey);
      expect(record.pubkeyHex).toBe(bytesToHex(pubkey));
      expect(record.relayEndpoints).toEqual(endpoints);

      // Empty endpoints list
      const emptyEndpoints = decodeNameRecord(concatBytes([owner, pubkey, encodeBincodeStringVec([])]));
      expect(emptyEndpoints.relayEndpoints).toEqual([]);

      expectDecodeError(() => decodeNameRecord(bytes.slice(0, -2)), "TRUNCATED");
      expectDecodeError(() => decodeNameRecord(concatBytes([bytes, Uint8Array.of(0)])), "TRAILING_BYTES");
    });
  });

  describe("decodeNftMetadata", () => {
    it("round-trips NftState collection metadata with tokens and optional approvals", () => {
      const owner = addr(0x51);
      const minter = addr(0x52);
      const holder1 = addr(0x53);
      const holder2 = addr(0x54);
      const approved = addr(0x55);

      const bytes = concatBytes([
        encodeBincodeString("Kovanica Genesis"),
        encodeBincodeString("KGEN"),
        encodeBincodeString("ipfs://bafybase/"),
        owner,
        minter,
        u64le(2n),
        // Token 1 (no approval)
        u128le(1n),
        holder1,
        Uint8Array.of(0),
        encodeBincodeString("1.json"),
        // Token 2 (with approval)
        u128le(2n),
        holder2,
        Uint8Array.of(1),
        approved,
        encodeBincodeString("2.json"),
      ]);

      const nft = decodeNftMetadata(bytes);
      expect(decodeNftState(bytes)).toEqual(nft);
      expect(nft.name).toBe("Kovanica Genesis");
      expect(nft.symbol).toBe("KGEN");
      expect(nft.baseUri).toBe("ipfs://bafybase/");
      expect(nft.owner).toEqual(owner);
      expect(nft.minter).toEqual(minter);
      expect(nft.tokens).toHaveLength(2);
      expect(nft.tokens[0]).toEqual({
        tokenId: 1n,
        owner: holder1,
        ownerHex: bytesToHex(holder1),
        approved: null,
        approvedHex: null,
        tokenUri: "1.json",
      });
      expect(nft.tokens[1]).toEqual({
        tokenId: 2n,
        owner: holder2,
        ownerHex: bytesToHex(holder2),
        approved,
        approvedHex: bytesToHex(approved),
        tokenUri: "2.json",
      });

      expectDecodeError(() => decodeNftMetadata(bytes.slice(0, -1)), "TRUNCATED");
      expectDecodeError(() => decodeNftMetadata(concatBytes([bytes, Uint8Array.of(0)])), "TRAILING_BYTES");
    });
  });

  describe("decodeEscrowRecord", () => {
    function encodeEscrow(released: boolean, refunded: boolean): Uint8Array {
      return concatBytes([
        addr(0x61), // creator
        encodeBincodeBytes32Vec([addr(0x62), addr(0x63), addr(0x64)]), // parties
        Uint8Array.of(2), // threshold
        encodeBincodeBytes32Vec([addr(0x62)]), // approvals
        u128le(750_000_000n), // amount
        u64le(2_000_000n), // deadline
        Uint8Array.of(released ? 1 : 0),
        Uint8Array.of(refunded ? 1 : 0),
      ]);
    }

    it("round-trips open, released, and refunded Escrow records", () => {
      const open = decodeEscrowRecord(encodeEscrow(false, false));
      expect(open.creator).toEqual(addr(0x61));
      expect(open.parties).toHaveLength(3);
      expect(open.threshold).toBe(2);
      expect(open.approvals).toHaveLength(1);
      expect(open.amount).toBe(750_000_000n);
      expect(open.deadline).toBe(2_000_000n);
      expect(open.released).toBe(false);
      expect(open.refunded).toBe(false);
      expect(open.status).toBe("open");

      expect(decodeEscrowRecord(encodeEscrow(true, false)).status).toBe("released");
      expect(decodeEscrowRecord(encodeEscrow(false, true)).status).toBe("refunded");
    });

    it("rejects contradictory, truncated, trailing, and invalid-bool Escrow records", () => {
      const valid = encodeEscrow(false, false);
      expectDecodeError(() => decodeEscrowRecord(encodeEscrow(true, true)), "INVALID_INPUT");
      expectDecodeError(() => decodeEscrowRecord(valid.slice(0, -1)), "TRUNCATED");
      expectDecodeError(() => decodeEscrowRecord(concatBytes([valid, Uint8Array.of(0)])), "TRAILING_BYTES");

      const badBool = valid.slice();
      badBool[badBool.length - 1] = 3;
      expectDecodeError(() => decodeEscrowRecord(badBool), "INVALID_BOOL");
    });
  });
});

describe("Storage Slot Key Derivation Helpers", () => {
  const enc = new TextEncoder();

  it("derives canonical BLAKE3 storage slots matching kovanica-l1 contracts", () => {
    const stateSlot = blake3(enc.encode(STORAGE_KEY_PREFIXES.STATE));
    expect(deriveStorageSlot("state")).toEqual(stateSlot);
    expect(deriveStorageSlot("token")).toEqual(stateSlot);
    expect(deriveStorageSlot("nft")).toEqual(stateSlot);
    expect(deriveStorageSlot("multisig")).toEqual(stateSlot);
    expect(deriveStorageSlotHex("token")).toBe(bytesToHex(stateSlot));

    const poolSlot = blake3(enc.encode(STORAGE_KEY_PREFIXES.POOL));
    expect(deriveStorageSlot("token_pool")).toEqual(poolSlot);

    const id = addr(0xab);
    expect(deriveStorageSlot("token_lp", id)).toEqual(
      blake3(concatBytes([enc.encode("kvnc/v1/lp/"), id])),
    );
    expect(deriveStorageSlot("htlc", id)).toEqual(
      blake3(concatBytes([enc.encode("kvnc/v1/htlc/"), id])),
    );
    expect(deriveStorageSlot("htlc", `0x${bytesToHex(id)}`)).toEqual(
      blake3(concatBytes([enc.encode("kvnc/v1/htlc/"), id])),
    );
    expect(deriveStorageSlot("vault", id)).toEqual(
      blake3(concatBytes([enc.encode("kvnc/v1/vault/"), id])),
    );
    expect(deriveStorageSlot("escrow", id)).toEqual(
      blake3(concatBytes([enc.encode("kvnc/v1/escrow/"), id])),
    );

    expect(deriveStorageSlot("multisig_tx", 42n)).toEqual(
      blake3(concatBytes([enc.encode("kvnc/v1/mtx/"), u64le(42n)])),
    );
    expect(deriveStorageSlot("multisig_tx", 42)).toEqual(
      blake3(concatBytes([enc.encode("kvnc/v1/mtx/"), u64le(42n)])),
    );
    expect(deriveStorageSlot("multisig_tx", u64le(42n))).toEqual(
      blake3(concatBytes([enc.encode("kvnc/v1/mtx/"), u64le(42n)])),
    );

    // Name slot normalizes ASCII uppercase to lowercase
    expect(deriveStorageSlot("name", "Alice")).toEqual(
      blake3(concatBytes([enc.encode("kvnc/v1/name/"), enc.encode("alice")])),
    );

    // Generic prefixed helper
    expect(derivePrefixedStorageSlot("kvnc/v1/custom/", new Uint8Array([1, 2]))).toEqual(
      blake3(concatBytes([enc.encode("kvnc/v1/custom/"), new Uint8Array([1, 2])])),
    );
  });

  it("rejects invalid or missing keys in deriveStorageSlot", () => {
    expectDecodeError(() => deriveStorageSlot("htlc"), "INVALID_INPUT");
    expectDecodeError(() => deriveStorageSlot("htlc", new Uint8Array(16)), "INVALID_INPUT");
    expectDecodeError(() => deriveStorageSlot("vault", 123n), "INVALID_INPUT");
    expectDecodeError(() => deriveStorageSlot("multisig_tx"), "INVALID_INPUT");
    expectDecodeError(() => deriveStorageSlot("multisig_tx", "42"), "INVALID_INPUT");
    expectDecodeError(() => deriveStorageSlot("multisig_tx", new Uint8Array(4)), "INVALID_INPUT");
    expectDecodeError(() => deriveStorageSlot("name", ""), "INVALID_INPUT");
    expectDecodeError(() => deriveStorageSlot("name", "   "), "INVALID_INPUT");
  });
});

describe("decodeContractLog Dispatcher", () => {
  it("dispatches across all canonical contract record/log kinds and returns a typed discriminated union", () => {
    const sender = addr(0x01);
    const claimer = addr(0x02);
    const hashLock = blake3(new TextEncoder().encode("log-preimage"));

    // 1. htlc
    const htlcBytes = concatBytes([
      sender,
      claimer,
      u128le(500_000n),
      hashLock,
      u64le(1_234_567n),
      Uint8Array.of(1),
      Uint8Array.of(0),
    ]);
    const htlcLog = decodeContractLog(`0x${bytesToHex(htlcBytes)}`, "htlc");
    expect(htlcLog.kind).toBe("htlc");
    expect(htlcLog.record.status).toBe("claimed");
    expect(htlcLog.record.amount).toBe(500_000n);

    // 2. vault
    const vaultBytes = concatBytes([
      sender,
      claimer,
      u128le(1_000_000n),
      u128le(100_000n),
      u32le(0),
      u64le(50_000n),
      Uint8Array.of(0),
    ]);
    const vaultLog = decodeContractLog(vaultBytes, "vault");
    expect(vaultLog.kind).toBe("vault");
    expect(vaultLog.record.schedule).toEqual({ kind: "absolute", unlockAt: 50_000n });

    // 3. multisig_state
    const msStateBytes = concatBytes([
      encodeBincodeBytes32Vec([sender, claimer]),
      u32le(2),
      u64le(9n),
    ]);
    const msStateLog = decodeContractLog(msStateBytes, "multisig_state");
    expect(msStateLog.kind).toBe("multisig_state");
    expect(msStateLog.record.threshold).toBe(2);
    expect(msStateLog.record.nextTxId).toBe(9n);

    // 4. multisig_tx
    const msTxBytes = concatBytes([
      u64le(3n),
      claimer,
      u128le(42_000n),
      bincodeBytes(new Uint8Array([0xaa, 0xbb])),
      encodeBincodeBytes32Vec([sender]),
      Uint8Array.of(0),
    ]);
    const msTxLog = decodeContractLog(msTxBytes, "multisig_tx");
    expect(msTxLog.kind).toBe("multisig_tx");
    expect(msTxLog.record.id).toBe(3n);
    expect(msTxLog.record.dataHex).toBe("aabb");

    // 5. token_metadata
    const tokenBytes = concatBytes([
      encodeBincodeString("Kovanica Token"),
      encodeBincodeString("KVT"),
      Uint8Array.of(9),
      u128le(10_000_000n),
      sender,
      claimer,
      u64le(0n),
      u64le(0n),
      Uint8Array.of(0),
      encodeBincodeString("https://kovanica.org/kvt.png"),
    ]);
    const tokenLog = decodeContractLog(tokenBytes, "token_metadata");
    expect(tokenLog.kind).toBe("token_metadata");
    expect(tokenLog.record.symbol).toBe("KVT");
    expect(tokenLog.record.icon).toBe("https://kovanica.org/kvt.png");

    // 6. token_pool
    const poolBytes = concatBytes([
      u128le(1_000n),
      u128le(2_000n),
      u16le(25),
      u128le(1_414n),
      Uint8Array.of(0),
    ]);
    const poolLog = decodeContractLog(poolBytes, "token_pool");
    expect(poolLog.kind).toBe("token_pool");
    expect(poolLog.record.feeBps).toBe(25);

    // 7. name
    const nameBytes = concatBytes([
      sender,
      claimer,
      encodeBincodeStringVec(["https://relay.kovanica.org"]),
    ]);
    const nameLog = decodeContractLog(`0x${bytesToHex(nameBytes)}`, "name");
    expect(nameLog.kind).toBe("name");
    expect(nameLog.record.relayEndpoints).toEqual(["https://relay.kovanica.org"]);

    // 8. nft_metadata
    const nftBytes = concatBytes([
      encodeBincodeString("Kovanica NFT"),
      encodeBincodeString("KNFT"),
      encodeBincodeString("ipfs://base/"),
      sender,
      claimer,
      u64le(0n),
    ]);
    const nftLog = decodeContractLog(nftBytes, "nft_metadata");
    expect(nftLog.kind).toBe("nft_metadata");
    expect(nftLog.record.symbol).toBe("KNFT");

    // 9. escrow
    const escrowBytes = concatBytes([
      sender,
      encodeBincodeBytes32Vec([sender, claimer]),
      Uint8Array.of(2),
      encodeBincodeBytes32Vec([sender]),
      u128le(99_000n),
      u64le(500_000n),
      Uint8Array.of(0),
      Uint8Array.of(0),
    ]);
    const escrowLog = decodeContractLog(escrowBytes, "escrow");
    expect(escrowLog.kind).toBe("escrow");
    expect(escrowLog.record.status).toBe("open");
    expect(escrowLog.record.amount).toBe(99_000n);
  });

  it("fails closed with KovanicaDecodeError on unknown kind or malformed log data", () => {
    expectDecodeError(
      () => decodeContractLog("0x00", "unknown_kind" as never),
      "INVALID_INPUT",
    );
    expectDecodeError(() => decodeContractLog("0x1234", "htlc"), "TRUNCATED");
    expectDecodeError(() => decodeContractLog("0xzz", "name"), "INVALID_INPUT");
  });
});
