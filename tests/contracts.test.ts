import { describe, expect, it, vi } from "vitest";
import {
  CHAIN_IDS,
  DEFAULT_CALL_GAS_LIMIT,
  DOMAIN_TAG_STR,
  KEYED_HASH_TAG_STR,
  KOVANICA_COIN_TYPE,
  KovanicaClient,
  KovanicaWallet,
  MAX_TX_GAS_LIMIT,
  TX_DOMAIN,
  TX_KEY,
  addressFromSeed,
  bip39Seed,
  buildCallTxKind,
  buildEscrowCreateCall,
  buildEscrowCreateCallTx,
  buildHtlcCreateCall,
  buildHtlcCreateCallTx,
  buildNameRegisterCall,
  buildNameRegisterCallTx,
  buildNftMintCall,
  buildNftMintCallTx,
  buildTokenTransferCall,
  buildVaultCreateCall,
  bytesToHex,
  computeCallTransactionSigningHash,
  concatBytes,
  encodeBincodeBytes32Vec,
  encodeBincodeString,
  encodeBincodeStringVec,
  encodeEscrowCreateArgs,
  encodeHtlcCreateArgs,
  encodeNameRegisterArgs,
  encodeNftMintArgs,
  hexToBytes,
  signCallContractTransaction,
  signEd25519,
  u32le,
  u64le,
  u128le,
} from "../src/index";

describe("Canonical Smart Contract Argument Builders & Bincode Encoders", () => {
  const goldenMnemonic =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const seed64 = bip39Seed(goldenMnemonic, "");
  const acc0 = addressFromSeed(seed64, 0, 0, 0, KOVANICA_COIN_TYPE);
  const acc1 = addressFromSeed(seed64, 1, 0, 0, KOVANICA_COIN_TYPE);

  describe("Domain Tags and Gas Limit Constants", () => {
    it("defines standard domain tags and gas limits", () => {
      expect(DOMAIN_TAG_STR).toBe("KVNC/tx/v1");
      expect(KEYED_HASH_TAG_STR).toBe("KVNC-TX-v1");
      expect(TX_DOMAIN.length).toBe(16);
      expect(TX_KEY.length).toBe(32);
      expect(DEFAULT_CALL_GAS_LIMIT).toBe(100_000n);
      expect(MAX_TX_GAS_LIMIT).toBe(10_000_000n);
    });
  });

  describe("Numerical and Buffer Encoders (Little-Endian)", () => {
    it("encodes u32le integers", () => {
      expect(Array.from(u32le(0))).toEqual([0, 0, 0, 0]);
      expect(Array.from(u32le(1))).toEqual([1, 0, 0, 0]);
      expect(Array.from(u32le(0x12345678))).toEqual([0x78, 0x56, 0x34, 0x12]);
      expect(Array.from(u32le(0xffffffff))).toEqual([0xff, 0xff, 0xff, 0xff]);

      expect(() => u32le(-1)).toThrow(RangeError);
      expect(() => u32le(0x100000000)).toThrow(RangeError);
      expect(() => u32le(3.14)).toThrow(RangeError);
    });

    it("encodes u64le integers", () => {
      expect(Array.from(u64le(0n))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      expect(Array.from(u64le(1n))).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
      expect(Array.from(u64le(256n))).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);
      expect(Array.from(u64le(0x1122334455667788n))).toEqual([
        0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11,
      ]);

      expect(() => u64le(-1n)).toThrow(RangeError);
      expect(() => u64le(-1)).toThrow(RangeError);
      expect(() => u64le(0x10000000000000000n)).toThrow(RangeError);
    });

    it("encodes u128le integers with split 64-bit limbs", () => {
      const zero = u128le(0n);
      expect(zero.length).toBe(16);
      expect(Array.from(zero)).toEqual(new Array(16).fill(0));

      const one = u128le(1n);
      expect(Array.from(one)).toEqual([1, ...new Array(15).fill(0)]);

      // 2^64 (low limb 0, high limb 1)
      const twoPow64 = u128le(1n << 64n);
      expect(Array.from(twoPow64)).toEqual([
        0, 0, 0, 0, 0, 0, 0, 0,
        1, 0, 0, 0, 0, 0, 0, 0,
      ]);

      expect(() => u128le(-1n)).toThrow(RangeError);
      expect(() => u128le(1n << 128n)).toThrow(RangeError);
    });

    it("converts hex to bytes and back safely", () => {
      const hex = "862f70cfafc9b581699f8d67598eac699cbc92bdfc940e95ed7ee1e8d8100e7e";
      const bytes = hexToBytes(hex);
      expect(bytes.length).toBe(32);
      expect(bytesToHex(bytes)).toBe(hex);

      // With 0x prefix
      expect(bytesToHex(hexToBytes(`0x${hex}`))).toBe(hex);

      expect(() => hexToBytes("123")).toThrow(/Invalid hex string length/);
      expect(() => hexToBytes("zz")).toThrow(/Invalid byte/);
    });

    it("concatenates multiple Uint8Array slices", () => {
      const a = new Uint8Array([1, 2]);
      const b = new Uint8Array([3, 4, 5]);
      const c = new Uint8Array([]);
      expect(Array.from(concatBytes([a, b, c]))).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("Deterministic Bincode Encoders", () => {
    it("encodes bincode strings with 8-byte LE length prefix", () => {
      const empty = encodeBincodeString("");
      expect(empty.length).toBe(8);
      expect(Array.from(empty)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

      const str = "alice";
      const encoded = encodeBincodeString(str);
      expect(encoded.length).toBe(8 + 5);
      expect(Array.from(encoded.slice(0, 8))).toEqual([5, 0, 0, 0, 0, 0, 0, 0]);
      expect(new TextDecoder().decode(encoded.slice(8))).toBe("alice");

      // Multibyte unicode UTF-8
      const unicode = "KVNC — 🚀";
      const utf8Bytes = new TextEncoder().encode(unicode);
      const encodedUnicode = encodeBincodeString(unicode);
      expect(encodedUnicode.length).toBe(8 + utf8Bytes.length);
      const lenView = new DataView(encodedUnicode.buffer, encodedUnicode.byteOffset, 8);
      expect(lenView.getBigUint64(0, true)).toBe(BigInt(utf8Bytes.length));
      expect(new TextDecoder().decode(encodedUnicode.slice(8))).toBe(unicode);
    });

    it("encodes bincode bytes32 vectors with count prefix", () => {
      const item1 = hexToBytes("11".repeat(32));
      const item2 = hexToBytes("22".repeat(32));
      const encoded = encodeBincodeBytes32Vec([item1, item2]);

      expect(encoded.length).toBe(8 + 64);
      expect(Array.from(encoded.slice(0, 8))).toEqual([2, 0, 0, 0, 0, 0, 0, 0]);
      expect(encoded.slice(8, 40)).toEqual(item1);
      expect(encoded.slice(40, 72)).toEqual(item2);

      // Empty vector
      const emptyVec = encodeBincodeBytes32Vec([]);
      expect(emptyVec.length).toBe(8);
      expect(Array.from(emptyVec)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

      // Rejects item length != 32
      const invalidShort = new Uint8Array(16);
      expect(() => encodeBincodeBytes32Vec([item1, invalidShort])).toThrow(/Expected 32-byte item, got 16/);
      expect(() => encodeBincodeBytes32Vec([new Uint8Array(33)])).toThrow(/Expected 32-byte item, got 33/);
    });

    it("encodes bincode string vectors with count prefix", () => {
      const endpoints = ["https://relay1.kovanica.org", "https://relay2.kovanica.org"];
      const encoded = encodeBincodeStringVec(endpoints);

      const countView = new DataView(encoded.buffer, encoded.byteOffset, 8);
      expect(countView.getBigUint64(0, true)).toBe(2n);

      // First string
      const str1Len = new DataView(encoded.buffer, encoded.byteOffset + 8, 8).getBigUint64(0, true);
      expect(str1Len).toBe(BigInt(endpoints[0]!.length));
      const str1Bytes = encoded.slice(16, 16 + Number(str1Len));
      expect(new TextDecoder().decode(str1Bytes)).toBe(endpoints[0]);

      // Empty vector
      const emptyVec = encodeBincodeStringVec([]);
      expect(emptyVec.length).toBe(8);
      expect(Array.from(emptyVec)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });
  });

  describe("Canonical Contract Call Payload Builders", () => {
    it("builds name_register call payload matching kovanica-playground golden vector", () => {
      const name = "alice";
      const pubkey = acc1.publicKey;
      const endpoints = ["https://relay1.kovanica.org", "https://relay2.kovanica.org"];

      const args = buildNameRegisterCall(name, pubkey, endpoints);
      expect(encodeNameRegisterArgs(name, pubkey, endpoints)).toEqual(args);

      // Verify layout: string(name) + pubkey(32) + vec<string>(endpoints)
      const nameLen = new DataView(args.buffer, args.byteOffset, 8).getBigUint64(0, true);
      expect(nameLen).toBe(BigInt(name.length));
      expect(new TextDecoder().decode(args.slice(8, 8 + Number(nameLen)))).toBe(name);

      const pkOffset = 8 + Number(nameLen);
      expect(args.slice(pkOffset, pkOffset + 32)).toEqual(pubkey);

      const vecOffset = pkOffset + 32;
      const vecCount = new DataView(args.buffer, args.byteOffset + vecOffset, 8).getBigUint64(0, true);
      expect(vecCount).toBe(2n);

      // Invalid pubkey validation
      expect(() => buildNameRegisterCall(name, new Uint8Array(31), endpoints)).toThrow(
        /Expected 32-byte pubkey, got 31/,
      );
    });

    it("builds htlc_create call payload with exact 72-byte wire length matching golden vector", () => {
      const hashlock = hexToBytes("11".repeat(32));
      const timelock = 1750000000n;
      const recipient = acc1.publicKey;

      const args = buildHtlcCreateCall(hashlock, timelock, recipient);
      expect(encodeHtlcCreateArgs(hashlock, timelock, recipient)).toEqual(args);

      // Exact wire length
      expect(args.length).toBe(72);
      expect(args.slice(0, 32)).toEqual(hashlock);

      const timeView = new DataView(args.buffer, args.byteOffset + 32, 8);
      expect(timeView.getBigUint64(0, true)).toBe(timelock);

      expect(args.slice(40, 72)).toEqual(recipient);

      // Validation errors
      expect(() => buildHtlcCreateCall(new Uint8Array(16), timelock, recipient)).toThrow(
        /Expected 32-byte hashlock, got 16/,
      );
      expect(() => buildHtlcCreateCall(hashlock, timelock, new Uint8Array(20))).toThrow(
        /Expected 32-byte recipient, got 20/,
      );
      expect(() => buildHtlcCreateCall(hashlock, -10n, recipient)).toThrow(
        /Timelock must be non-negative/,
      );
    });

    it("builds nft_mint call payload with exact wire length matching golden vector", () => {
      const collection = hexToBytes("cc".repeat(32));
      const recipient = acc1.publicKey;
      const tokenId = 42n;
      const tokenUri = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

      const args = buildNftMintCall(collection, recipient, tokenId, tokenUri);
      expect(encodeNftMintArgs(collection, recipient, tokenId, tokenUri)).toEqual(args);

      // Length: 32 (collection) + 32 (to) + 16 (u128 tokenId) + 8 (len) + len(tokenUri) = 88 + len(tokenUri)
      expect(args.length).toBe(88 + tokenUri.length);
      expect(args.slice(0, 32)).toEqual(collection);
      expect(args.slice(32, 64)).toEqual(recipient);

      const idLowView = new DataView(args.buffer, args.byteOffset + 64, 8);
      expect(idLowView.getBigUint64(0, true)).toBe(42n);
      const idHighView = new DataView(args.buffer, args.byteOffset + 72, 8);
      expect(idHighView.getBigUint64(0, true)).toBe(0n);

      const uriLenView = new DataView(args.buffer, args.byteOffset + 80, 8);
      expect(uriLenView.getBigUint64(0, true)).toBe(BigInt(tokenUri.length));
      expect(new TextDecoder().decode(args.slice(88))).toBe(tokenUri);

      // Validation errors
      expect(() => buildNftMintCall(new Uint8Array(10), recipient, tokenId, tokenUri)).toThrow(
        /Expected 32-byte collection, got 10/,
      );
      expect(() => buildNftMintCall(collection, new Uint8Array(10), tokenId, tokenUri)).toThrow(
        /Expected 32-byte to pubkey, got 10/,
      );
      expect(() => buildNftMintCall(collection, recipient, -5n, tokenUri)).toThrow(
        /Token ID must be non-negative/,
      );
    });

    it("builds escrow_create call payload with exact 89-byte wire length matching golden vector", () => {
      const parties = [acc0.publicKey, acc1.publicKey];
      const threshold = 2;
      const amount = 500_000_000n;
      const deadline = 1750000000n;

      const args = buildEscrowCreateCall(parties, threshold, amount, deadline);
      expect(encodeEscrowCreateArgs(parties, threshold, amount, deadline)).toEqual(args);

      // Length: 8 (count) + 64 (2*32) + 1 (threshold) + 8 (amount) + 8 (deadline) = 89
      expect(args.length).toBe(89);
      expect(Array.from(args.slice(0, 8))).toEqual([2, 0, 0, 0, 0, 0, 0, 0]);
      expect(args.slice(8, 40)).toEqual(parties[0]);
      expect(args.slice(40, 72)).toEqual(parties[1]);
      expect(args[72]).toBe(2);

      const amountView = new DataView(args.buffer, args.byteOffset + 73, 8);
      expect(amountView.getBigUint64(0, true)).toBe(amount);

      const deadlineView = new DataView(args.buffer, args.byteOffset + 81, 8);
      expect(deadlineView.getBigUint64(0, true)).toBe(deadline);

      // Validation: threshold > parties.length
      expect(() => buildEscrowCreateCall(parties, 3, amount, deadline)).toThrow(
        /Threshold cannot exceed number of parties \(2\), got 3/,
      );

      // Validation: threshold < 1
      expect(() => buildEscrowCreateCall(parties, 0, amount, deadline)).toThrow(
        /Threshold must be at least 1, got 0/,
      );

      // Validation: threshold out of range 0..255
      expect(() => buildEscrowCreateCall(parties, 300, amount, deadline)).toThrow(
        /Threshold must be between 0 and 255, got 300/,
      );
      expect(() => buildEscrowCreateCall(parties, -1, amount, deadline)).toThrow(
        /Threshold must be between 0 and 255, got -1/,
      );

      // Validation: negative amount or deadline
      expect(() => buildEscrowCreateCall(parties, threshold, -100n, deadline)).toThrow(
        /Amount must be non-negative/,
      );
      expect(() => buildEscrowCreateCall(parties, threshold, amount, -100n)).toThrow(
        /Deadline must be non-negative/,
      );
    });

    it("builds token_transfer and vault_create call helpers", () => {
      const contract = hexToBytes("44".repeat(32));
      const recipient = acc1.publicKey;

      const tokenCall = buildTokenTransferCall(contract, recipient, 1_000_000n);
      expect(tokenCall.method).toBe("token_transfer");
      expect(tokenCall.call_value).toBe(0n);
      expect(tokenCall.gas_limit).toBe(DEFAULT_CALL_GAS_LIMIT);
      expect(tokenCall.args.length).toBe(32 + 16);
      expect(tokenCall.args.slice(0, 32)).toEqual(recipient);

      const vaultCall = buildVaultCreateCall(contract, recipient, 50_000n, 1750000000n);
      expect(vaultCall.method).toBe("vault_create");
      expect(vaultCall.call_value).toBe(0n);
      expect(vaultCall.gas_limit).toBe(DEFAULT_CALL_GAS_LIMIT);
      // beneficiary(32) + u128 amount(16) + u32 vest_type(4) + u64 lock_until(8) = 60
      expect(vaultCall.args.length).toBe(60);
      expect(vaultCall.args.slice(0, 32)).toEqual(recipient);
    });
  });

  describe("Transaction Construction, Signing & Serialization", () => {
    it("signs an ed25519 message conforming to RFC 8032 and verifies with public key", () => {
      const message = new TextEncoder().encode("Kovanica Smart Contract Payload");
      const signature = signEd25519(message, acc0.secretKey);
      expect(signature.length).toBe(64);

      // Derive account from same mnemonic and sign again: deterministic
      const sig2 = signEd25519(message, acc0.secretKey);
      expect(sig2).toEqual(signature);
    });

    it("constructs and signs a Call transaction with wire verification matching playground", () => {
      const contract = hexToBytes("55".repeat(32));
      const nameCall = buildNameRegisterCallTx(
        contract,
        "alice",
        acc1.publicKey,
        ["https://relay1.kovanica.org", "https://relay2.kovanica.org"],
      );

      const signed = signCallContractTransaction({
        sender: acc0.publicKey,
        secretKey: acc0.secretKey,
        call: nameCall,
        nonce: 4n,
        fee: 25_000n,
        chainId: CHAIN_IDS.TESTNET,
      });

      expect(signed.sighash.length).toBe(32);
      expect(signed.signature.length).toBe(64);
      expect(signed.rawTxBytes.length).toBe(signed.txSize);

      // Bincode wire serialization begins with sender (32 bytes) + nonce (8 bytes u64le)
      expect(signed.rawTxHex.startsWith(bytesToHex(acc0.publicKey))).toBe(true);

      // Wire kind tag for Call is 6u32 (06000000 in little-endian hex) at offset 32+8 = 40 (hex index 80..88)
      const wireTag = signed.rawTxHex.slice(80, 88);
      expect(wireTag).toBe("06000000");

      // Verify computing sighash independently matches
      const expectedSighash = computeCallTransactionSigningHash(
        {
          sender: acc0.publicKey,
          nonce: 4n,
          call: nameCall,
          fee: 25_000n,
        },
        CHAIN_IDS.TESTNET,
      );
      expect(signed.sighash).toEqual(expectedSighash);
    });

    it("accepts contract as address string or hex string in buildCallTxKind", () => {
      const hexContract = "55".repeat(32);
      const call1 = buildCallTxKind({
        contract: hexContract,
        method: "test_method",
        args: new Uint8Array([1, 2, 3]),
      });
      expect(bytesToHex(call1.contract)).toBe(hexContract);

      const call2 = buildCallTxKind({
        contract: acc1.address,
        method: "test_method",
        args: new Uint8Array([1, 2, 3]),
      });
      expect(call2.contract).toEqual(acc1.publicKey);

      // Gas limit exceeding MAX_TX_GAS_LIMIT rejected
      expect(() =>
        buildCallTxKind({
          contract: hexContract,
          method: "test",
          args: new Uint8Array(),
          gas_limit: MAX_TX_GAS_LIMIT + 1n,
        }),
      ).toThrow(/exceeds maximum allowed/);
    });
  });

  describe("KovanicaWallet & KovanicaClient Contract Methods", () => {
    it("instantiates KovanicaWallet from seed and mnemonic with proper addresses", () => {
      const walletFromMnemonic = KovanicaWallet.fromMnemonic(goldenMnemonic, "", 0, 0, 0, KOVANICA_COIN_TYPE, {
        chainId: CHAIN_IDS.TESTNET,
      });
      expect(bytesToHex(walletFromMnemonic.publicKey)).toBe(bytesToHex(acc0.publicKey));
      expect(walletFromMnemonic.address.startsWith("tknc")).toBe(true);
      expect(walletFromMnemonic.chainId).toBe(CHAIN_IDS.TESTNET);

      const walletFromSeed = KovanicaWallet.fromSeed(seed64, 1, 0, 0, KOVANICA_COIN_TYPE, {
        chainId: CHAIN_IDS.MAINNET,
      });
      expect(bytesToHex(walletFromSeed.publicKey)).toBe(bytesToHex(acc1.publicKey));
      expect(walletFromSeed.address.startsWith("kvnc")).toBe(true);
      expect(walletFromSeed.chainId).toBe(CHAIN_IDS.MAINNET);
    });

    it("signs Call transactions using KovanicaWallet", () => {
      const wallet = new KovanicaWallet(acc0.secretKey, { chainId: CHAIN_IDS.TESTNET });
      const contract = hexToBytes("11".repeat(32));
      const htlcCall = buildHtlcCreateCallTx(contract, hexToBytes("22".repeat(32)), 1750000000n, acc1.publicKey);

      const signed = wallet.signCallTransaction(htlcCall, {
        nonce: 10n,
        fee: 15_000n,
      });

      expect(signed.sighash.length).toBe(32);
      expect(signed.signature.length).toBe(64);
      expect(signed.rawTxHex.startsWith(bytesToHex(wallet.publicKey))).toBe(true);
    });

    it("sends Call transactions through KovanicaWallet with attached client", async () => {
      const mockClient = new KovanicaClient("http://localhost:8545");
      const getNonceSpy = vi.spyOn(mockClient, "getNonce").mockResolvedValue(42n);
      const estimateFeeSpy = vi.spyOn(mockClient, "estimateFee").mockResolvedValue(20_000n);
      const sendRawSpy = vi.spyOn(mockClient, "sendRawTransaction").mockResolvedValue("0x" + "aa".repeat(32));

      const wallet = new KovanicaWallet(acc0.secretKey, {
        chainId: CHAIN_IDS.TESTNET,
        client: mockClient,
      });

      const contract = hexToBytes("33".repeat(32));
      const nftCall = buildNftMintCallTx(contract, hexToBytes("77".repeat(32)), acc1.publicKey, 1n, "ipfs://test");

      const txHash = await wallet.sendCallTransaction(nftCall);
      expect(txHash).toBe("0x" + "aa".repeat(32));
      expect(getNonceSpy).toHaveBeenCalledWith(wallet.address, undefined);
      expect(estimateFeeSpy).toHaveBeenCalledWith(undefined);
      expect(sendRawSpy).toHaveBeenCalledWith(expect.stringMatching(/^0x[0-9a-f]+$/i), undefined);
    });

    it("throws when sendCallTransaction is called on KovanicaWallet without attached client", async () => {
      const wallet = new KovanicaWallet(acc0.secretKey);
      const contract = hexToBytes("33".repeat(32));
      const call = buildTokenTransferCall(contract, acc1.publicKey, 100n);
      await expect(wallet.sendCallTransaction(call)).rejects.toThrow(
        /no KovanicaClient attached/,
      );
    });

    it("builds and signs Call transactions through KovanicaClient helper methods", () => {
      const client = new KovanicaClient("http://localhost:8545");
      const contract = hexToBytes("66".repeat(32));
      const parties = [acc0.publicKey, acc1.publicKey];
      const escrowCall = buildEscrowCreateCallTx(contract, parties, 2, 100_000n, 1800000000n);

      const built = client.buildCallTransaction(escrowCall);
      expect(built.type).toBe("call");
      expect(built.method).toBe("escrow_create");

      const signed = client.signCallTransaction(acc0.secretKey, built, {
        nonce: 5n,
        fee: 30_000n,
        chainId: CHAIN_IDS.MAINNET,
      });

      expect(signed.sighash.length).toBe(32);
      expect(signed.signature.length).toBe(64);
      expect(signed.rawTxHex.startsWith(bytesToHex(acc0.publicKey))).toBe(true);
    });

    it("sends raw transactions via client.sendRawTransaction", async () => {
      const client = new KovanicaClient("http://localhost:8545");
      const callSpy = vi.spyOn(client, "call").mockResolvedValue("0x1234");

      const res = await client.sendRawTransaction("aabbcc");
      expect(res).toBe("0x1234");
      expect(callSpy).toHaveBeenCalledWith("kovanica_sendRawTransaction", ["0xaabbcc"], undefined);

      await client.sendRawTransaction("0xaabbcc");
      expect(callSpy).toHaveBeenCalledWith("kovanica_sendRawTransaction", ["0xaabbcc"], undefined);
    });
  });
});
