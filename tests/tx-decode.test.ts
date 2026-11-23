import { describe, expect, it } from "vitest";
import { encodeAddress } from "../src/address";
import { CHAIN_IDS } from "../src/chains";
import {
  buildNameRegisterCall,
  bytesToHex,
  signCallContractTransaction,
} from "../src/contracts";
import { KovanicaDecodeError } from "../src/decoders";
import {
  decodeSignedCallTransaction,
  verifyCallTransactionSignature,
  verifyEd25519,
} from "../src/tx-decode";
import { getPublicKey } from "../src/wallet";

function makeDeterministicBytes(len: number, seed: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = (seed + i * 31) & 0xff;
  }
  return out;
}

describe("decodeSignedCallTransaction & verifyCallTransactionSignature", () => {
  const secretKey = makeDeterministicBytes(32, 0x11);
  const publicKey = getPublicKey(secretKey);
  const contractBytes = makeDeterministicBytes(32, 0x42);
  const args = buildNameRegisterCall(
    "alice.kvnc",
    makeDeterministicBytes(32, 0x77),
    ["https://relay-1.kovanica.org"],
  );

  function buildSignedSample(overrides?: {
    nonce?: bigint;
    fee?: bigint;
    callValue?: bigint;
    gasLimit?: bigint;
    chainId?: number;
  }) {
    return signCallContractTransaction({
      sender: publicKey,
      secretKey,
      call: {
        contract: contractBytes,
        method: "name_register",
        args,
        call_value: overrides?.callValue ?? 250_000n,
        gas_limit: overrides?.gasLimit ?? 150_000n,
      },
      nonce: overrides?.nonce ?? 7n,
      fee: overrides?.fee ?? 12_500n,
      chainId: overrides?.chainId ?? CHAIN_IDS.MAINNET,
    });
  }

  it("round-trips signCallContractTransaction -> decodeSignedCallTransaction -> verifyCallTransactionSignature", () => {
    const signed = buildSignedSample();
    const decoded = decodeSignedCallTransaction(signed.rawTxBytes);

    expect(decoded.senderBytes).toEqual(publicKey);
    expect(decoded.senderHex).toBe(`0x${bytesToHex(publicKey)}`);
    expect(decoded.senderAddress).toBe(encodeAddress(publicKey));
    expect(decoded.senderAddress.startsWith("kvnc")).toBe(true);
    expect(decoded.senderAddress.endsWith("dag")).toBe(true);

    expect(decoded.nonce).toBe(7n);
    expect(decoded.fee).toBe(12_500n);
    expect(decoded.contractBytes).toEqual(contractBytes);
    expect(decoded.contractHex).toBe(`0x${bytesToHex(contractBytes)}`);
    expect(decoded.contractAddress).toBe(encodeAddress(contractBytes));
    expect(decoded.method).toBe("name_register");
    expect(decoded.callValue).toBe(250_000n);
    expect(decoded.args).toEqual(args);
    expect(decoded.argsHex).toBe(`0x${bytesToHex(args)}`);
    expect(decoded.gasLimit).toBe(150_000n);

    expect(decoded.signature).toEqual(signed.signature);
    expect(decoded.signatureHex).toBe(`0x${signed.signatureHex}`);
    expect(decoded.signingHash).toEqual(signed.sighash);
    expect(decoded.signingHashHex).toBe(`0x${signed.sighashHex}`);
    expect(decoded.wireHash).toEqual(signed.sighash);
    expect(decoded.wireHashHex).toBe(`0x${signed.sighashHex}`);
    expect(decoded.chainId).toBe(CHAIN_IDS.MAINNET);
    expect(decoded.wireSizeBytes).toBe(signed.txSize);

    expect(verifyCallTransactionSignature(decoded)).toBe(true);
    expect(verifyCallTransactionSignature(decoded, publicKey)).toBe(true);

    const otherPubkey = getPublicKey(makeDeterministicBytes(32, 0x99));
    expect(verifyCallTransactionSignature(decoded, otherPubkey)).toBe(false);
  });

  it("accepts 0x-prefixed hex, bare hex, and Uint8Array inputs identically", () => {
    const signed = buildSignedSample();

    const fromBytes = decodeSignedCallTransaction(signed.rawTxBytes);
    const fromPrefixed = decodeSignedCallTransaction(`0x${signed.rawTxHex}`);
    const fromUpperPrefix = decodeSignedCallTransaction(`0X${signed.rawTxHex.toUpperCase()}`);
    const fromBare = decodeSignedCallTransaction(signed.rawTxHex);

    expect(fromPrefixed).toEqual(fromBytes);
    expect(fromUpperPrefix).toEqual(fromBytes);
    expect(fromBare).toEqual(fromBytes);

    expect(verifyCallTransactionSignature(fromPrefixed)).toBe(true);
    expect(verifyCallTransactionSignature(fromUpperPrefix)).toBe(true);
    expect(verifyCallTransactionSignature(fromBare)).toBe(true);
  });

  it("supports non-mainnet chainId option and fails verification on wrong chainId", () => {
    const signed = buildSignedSample({ chainId: CHAIN_IDS.TESTNET });

    const decodedTestnet = decodeSignedCallTransaction(signed.rawTxBytes, {
      chainId: CHAIN_IDS.TESTNET,
    });
    expect(decodedTestnet.chainId).toBe(CHAIN_IDS.TESTNET);
    expect(verifyCallTransactionSignature(decodedTestnet)).toBe(true);

    const decodedMainnet = decodeSignedCallTransaction(signed.rawTxBytes, {
      chainId: CHAIN_IDS.MAINNET,
    });
    expect(verifyCallTransactionSignature(decodedMainnet)).toBe(false);
  });

  it("returns false when tampering with nonce, fee, args, or signature", () => {
    const signed = buildSignedSample();
    const methodBytesLen = new TextEncoder().encode("name_register").length;

    // Layout offsets:
    // 0..32: sender (32)
    // 32..40: nonce (8)
    // 40..44: variant u32 (4)
    // 44..76: contract (32)
    // 76..84: call_value (8)
    // 84..92: method len (8)
    // 92..(92+methodLen): method
    // +0..8: args len
    // +8..(8+argsLen): args
    // +0..8: gas_limit
    // +0..8: fee
    // +0..8: sig len (64)
    // +0..64: signature
    // +0..32: wireHash
    const argsDataOffset = 92 + methodBytesLen + 8;
    const feeOffset = argsDataOffset + args.length + 8;
    const sigOffset = feeOffset + 8 + 8;

    const flipByteAt = (offset: number): Uint8Array => {
      const copy = new Uint8Array(signed.rawTxBytes);
      copy[offset] = copy[offset]! ^ 0x01;
      return copy;
    };

    // Tamper nonce
    const tamperedNonce = decodeSignedCallTransaction(flipByteAt(32));
    expect(tamperedNonce.nonce).not.toBe(7n);
    expect(verifyCallTransactionSignature(tamperedNonce)).toBe(false);

    // Tamper args
    const tamperedArgs = decodeSignedCallTransaction(flipByteAt(argsDataOffset + 5));
    expect(verifyCallTransactionSignature(tamperedArgs)).toBe(false);

    // Tamper fee
    const tamperedFee = decodeSignedCallTransaction(flipByteAt(feeOffset));
    expect(tamperedFee.fee).not.toBe(12_500n);
    expect(verifyCallTransactionSignature(tamperedFee)).toBe(false);

    // Tamper signature (both R and S halves)
    const tamperedSigR = decodeSignedCallTransaction(flipByteAt(sigOffset));
    expect(verifyCallTransactionSignature(tamperedSigR)).toBe(false);

    const tamperedSigS = decodeSignedCallTransaction(flipByteAt(sigOffset + 40));
    expect(verifyCallTransactionSignature(tamperedSigS)).toBe(false);
  });

  it("never throws on invalid signature or public key bytes in verifyCallTransactionSignature", () => {
    const signed = buildSignedSample();
    const decoded = decodeSignedCallTransaction(signed.rawTxBytes);

    // All-0xff signature has S >= L and invalid point encoding
    const badSigDecoded = {
      ...decoded,
      signature: new Uint8Array(64).fill(0xff),
    };
    expect(verifyCallTransactionSignature(badSigDecoded)).toBe(false);

    // Invalid public key (all 0xff -> y >= P)
    expect(verifyCallTransactionSignature(decoded, new Uint8Array(32).fill(0xff))).toBe(false);

    // Wrong lengths
    expect(verifyCallTransactionSignature(decoded, new Uint8Array(16))).toBe(false);
    expect(
      verifyCallTransactionSignature({
        ...decoded,
        signature: new Uint8Array(32),
      }),
    ).toBe(false);
    expect(
      verifyCallTransactionSignature({
        ...decoded,
        signingHash: new Uint8Array(16),
      }),
    ).toBe(false);

    // Direct verifyEd25519 edge cases
    expect(verifyEd25519(new Uint8Array(64).fill(0xff), new Uint8Array(32), publicKey)).toBe(false);
    expect(verifyEd25519(new Uint8Array(63), new Uint8Array(32), publicKey)).toBe(false);
  });

  it("rejects truncated bytes with KovanicaDecodeError(TRUNCATED)", () => {
    const signed = buildSignedSample();

    for (const cutLen of [0, 10, 32, 41, signed.rawTxBytes.length - 1]) {
      const truncated = signed.rawTxBytes.slice(0, cutLen);
      expect(() => decodeSignedCallTransaction(truncated)).toThrow(KovanicaDecodeError);
      try {
        decodeSignedCallTransaction(truncated);
      } catch (err) {
        expect(err).toBeInstanceOf(KovanicaDecodeError);
        expect((err as KovanicaDecodeError).code).toBe("TRUNCATED");
      }
    }
  });

  it("rejects trailing garbage bytes with KovanicaDecodeError(TRAILING_BYTES)", () => {
    const signed = buildSignedSample();
    const withTrailing = new Uint8Array(signed.rawTxBytes.length + 3);
    withTrailing.set(signed.rawTxBytes, 0);
    withTrailing.set([0xde, 0xad, 0xbe], signed.rawTxBytes.length);

    expect(() => decodeSignedCallTransaction(withTrailing)).toThrow(KovanicaDecodeError);
    try {
      decodeSignedCallTransaction(withTrailing);
    } catch (err) {
      expect(err).toBeInstanceOf(KovanicaDecodeError);
      expect((err as KovanicaDecodeError).code).toBe("TRAILING_BYTES");
    }
  });

  it("rejects wrong TransactionKind variant discriminant with KovanicaDecodeError(INVALID_VARIANT)", () => {
    const signed = buildSignedSample();
    const wrongVariant = new Uint8Array(signed.rawTxBytes);
    // Offset 40 is the u32 LE TransactionKind discriminant (6 for Call)
    new DataView(wrongVariant.buffer).setUint32(40, 0, true);

    expect(() => decodeSignedCallTransaction(wrongVariant)).toThrow(KovanicaDecodeError);
    try {
      decodeSignedCallTransaction(wrongVariant);
    } catch (err) {
      expect(err).toBeInstanceOf(KovanicaDecodeError);
      expect((err as KovanicaDecodeError).code).toBe("INVALID_VARIANT");
    }
  });

  it("rejects non-hex or odd-length hex strings with KovanicaDecodeError(INVALID_INPUT)", () => {
    for (const badInput of ["not-hex", "0xzz11", "0x123", "abc"]) {
      expect(() => decodeSignedCallTransaction(badInput)).toThrow(KovanicaDecodeError);
      try {
        decodeSignedCallTransaction(badInput);
      } catch (err) {
        expect(err).toBeInstanceOf(KovanicaDecodeError);
        expect((err as KovanicaDecodeError).code).toBe("INVALID_INPUT");
      }
    }
  });
});
