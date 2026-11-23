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
  TRANSFER_TX_VARIANT,
  TRANSFER_TX_WIRE_SIZE,
  computeTransferTransactionSigningHash,
  decodeSignedTransferTransaction,
  signTransferTransaction,
  verifyTransferTransactionSignature,
} from "../src/transfer-tx";
import { getPublicKey } from "../src/wallet";

function makeDeterministicBytes(len: number, seed: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = (seed + i * 29) & 0xff;
  }
  return out;
}

describe("transfer-tx: signTransferTransaction, decodeSignedTransferTransaction & verifyTransferTransactionSignature", () => {
  const privateKey = makeDeterministicBytes(32, 0x15);
  const publicKey = getPublicKey(privateKey);
  const recipientBytes = makeDeterministicBytes(32, 0x55);
  const recipientAddress = encodeAddress(recipientBytes);

  function buildSignedSample(overrides?: {
    to?: Uint8Array | string;
    amount?: bigint | number;
    nonce?: bigint | number;
    fee?: bigint | number;
    chainId?: bigint | number;
  }) {
    return signTransferTransaction({
      privateKey,
      to: overrides?.to ?? recipientAddress,
      amount: overrides?.amount ?? 2_500_000_000n,
      nonce: overrides?.nonce ?? 42n,
      fee: overrides?.fee ?? 1_500n,
      chainId: overrides?.chainId ?? CHAIN_IDS.MAINNET,
    });
  }

  it("matches L1 golden vector T1 from kovanica-types/src/transaction.rs byte-for-byte", () => {
    // Golden vector T1 from kovanica-l1/crates/kovanica-types/src/transaction.rs
    const goldenSecretKey = new Uint8Array(32).fill(7);
    const goldenRecipient = new Uint8Array(32).fill(0x22);

    const signed = signTransferTransaction({
      privateKey: goldenSecretKey,
      to: goldenRecipient,
      amount: 1_000_000n,
      nonce: 5n,
      fee: 1_000n,
      chainId: CHAIN_IDS.TESTNET,
    });

    expect(bytesToHex(signed.senderBytes)).toBe(
      "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c",
    );
    expect(signed.signingHashHex).toBe(
      "0aae8c1832e09bf7da6f897d20b8bc6a017aaeefd50ea10015218a5c4a54c21d",
    );
    expect(signed.signatureHex).toBe(
      "c24cd02ec98045a34e4b3102a1cafe70883a83763d5915528554b54797b139df1768cad71220e78bcb6702b109f37bb79513c1f768bacab4bf6e96f4e16cdf06",
    );
    expect(signed.rawTxBytes.length).toBe(TRANSFER_TX_WIRE_SIZE);

    const directHash = computeTransferTransactionSigningHash(
      {
        sender: signed.senderBytes,
        to: goldenRecipient,
        amount: 1_000_000n,
        nonce: 5n,
        fee: 1_000n,
      },
      CHAIN_IDS.TESTNET,
    );
    expect(bytesToHex(directHash)).toBe(signed.signingHashHex);

    const decoded = decodeSignedTransferTransaction(signed.rawTxBytes, {
      chainId: CHAIN_IDS.TESTNET,
    });
    expect(decoded.amount).toBe(1_000_000n);
    expect(decoded.nonce).toBe(5n);
    expect(decoded.fee).toBe(1_000n);
    expect(verifyTransferTransactionSignature(decoded)).toBe(true);
  });

  it("round-trips signTransferTransaction -> decodeSignedTransferTransaction -> verifyTransferTransactionSignature", () => {
    const signed = buildSignedSample();
    expect(signed.rawTxBytes.length).toBe(TRANSFER_TX_WIRE_SIZE);
    expect(signed.senderBytes).toEqual(publicKey);
    expect(signed.senderAddress).toBe(encodeAddress(publicKey));
    expect(signed.recipientBytes).toEqual(recipientBytes);
    expect(signed.recipientAddress).toBe(recipientAddress);

    const decoded = decodeSignedTransferTransaction(signed.rawTxBytes);

    expect(decoded.senderBytes).toEqual(publicKey);
    expect(decoded.senderHex).toBe(`0x${bytesToHex(publicKey)}`);
    expect(decoded.senderAddress).toBe(encodeAddress(publicKey));
    expect(decoded.senderAddress.startsWith("kvnc")).toBe(true);
    expect(decoded.senderAddress.endsWith("dag")).toBe(true);

    expect(decoded.nonce).toBe(42n);
    expect(decoded.fee).toBe(1_500n);
    expect(decoded.recipientBytes).toEqual(recipientBytes);
    expect(decoded.recipientHex).toBe(`0x${bytesToHex(recipientBytes)}`);
    expect(decoded.recipientAddress).toBe(recipientAddress);
    expect(decoded.amount).toBe(2_500_000_000n);

    expect(decoded.signature).toEqual(signed.signature);
    expect(decoded.signatureHex).toBe(`0x${signed.signatureHex}`);
    expect(decoded.signingHash).toEqual(signed.signingHash);
    expect(decoded.signingHashHex).toBe(`0x${signed.signingHashHex}`);
    expect(decoded.wireHash).toEqual(signed.signingHash);
    expect(decoded.wireHashHex).toBe(`0x${signed.signingHashHex}`);
    expect(decoded.chainId).toBe(BigInt(CHAIN_IDS.MAINNET));
    expect(decoded.wireSizeBytes).toBe(TRANSFER_TX_WIRE_SIZE);

    expect(verifyTransferTransactionSignature(decoded)).toBe(true);
    expect(verifyTransferTransactionSignature(decoded, publicKey)).toBe(true);

    const otherPubkey = getPublicKey(makeDeterministicBytes(32, 0x99));
    expect(verifyTransferTransactionSignature(decoded, otherPubkey)).toBe(false);
  });

  it("accepts 0x-prefixed hex, bare hex, and Uint8Array inputs identically", () => {
    const signed = buildSignedSample({ to: recipientBytes });

    const fromBytes = decodeSignedTransferTransaction(signed.rawTxBytes);
    const fromPrefixed = decodeSignedTransferTransaction(`0x${signed.rawTxHex}`);
    const fromUpperPrefix = decodeSignedTransferTransaction(
      `0X${signed.rawTxHex.toUpperCase()}`,
    );
    const fromBare = decodeSignedTransferTransaction(signed.rawTxHex);

    expect(fromPrefixed).toEqual(fromBytes);
    expect(fromUpperPrefix).toEqual(fromBytes);
    expect(fromBare).toEqual(fromBytes);

    expect(verifyTransferTransactionSignature(fromPrefixed)).toBe(true);
    expect(verifyTransferTransactionSignature(fromUpperPrefix)).toBe(true);
    expect(verifyTransferTransactionSignature(fromBare)).toBe(true);
  });

  it("supports non-mainnet chainId (number and bigint) and rejects mismatched chainId", () => {
    const signed = buildSignedSample({ chainId: BigInt(CHAIN_IDS.DEVNET) });

    const decodedDevnet = decodeSignedTransferTransaction(signed.rawTxBytes, {
      chainId: BigInt(CHAIN_IDS.DEVNET),
    });
    expect(decodedDevnet.chainId).toBe(BigInt(CHAIN_IDS.DEVNET));
    expect(verifyTransferTransactionSignature(decodedDevnet)).toBe(true);

    const decodedMainnet = decodeSignedTransferTransaction(signed.rawTxBytes, {
      chainId: CHAIN_IDS.MAINNET,
    });
    expect(verifyTransferTransactionSignature(decodedMainnet)).toBe(false);
  });

  it("returns false when tampering with amount, recipient, nonce, fee, or signature", () => {
    const signed = buildSignedSample();

    // Wire offsets for Transfer (196 bytes):
    // 0..32:   sender (32)
    // 32..40:  nonce (8)
    // 40..44:  variant u32 (4)
    // 44..76:  recipient (32)
    // 76..84:  amount (8)
    // 84..92:  fee (8)
    // 92..100: sig len u64 (8)
    // 100..164: signature (64)
    // 164..196: wireHash (32)
    const flipByteAt = (offset: number): Uint8Array => {
      const copy = new Uint8Array(signed.rawTxBytes);
      copy[offset] = copy[offset]! ^ 0x01;
      return copy;
    };

    // Tamper nonce
    const tamperedNonce = decodeSignedTransferTransaction(flipByteAt(32));
    expect(tamperedNonce.nonce).not.toBe(42n);
    expect(verifyTransferTransactionSignature(tamperedNonce)).toBe(false);

    // Tamper recipient
    const tamperedRecipient = decodeSignedTransferTransaction(flipByteAt(50));
    expect(tamperedRecipient.recipientBytes).not.toEqual(recipientBytes);
    expect(verifyTransferTransactionSignature(tamperedRecipient)).toBe(false);

    // Tamper amount
    const tamperedAmount = decodeSignedTransferTransaction(flipByteAt(76));
    expect(tamperedAmount.amount).not.toBe(2_500_000_000n);
    expect(verifyTransferTransactionSignature(tamperedAmount)).toBe(false);

    // Tamper fee
    const tamperedFee = decodeSignedTransferTransaction(flipByteAt(84));
    expect(tamperedFee.fee).not.toBe(1_500n);
    expect(verifyTransferTransactionSignature(tamperedFee)).toBe(false);

    // Tamper signature (both R and S halves)
    const tamperedSigR = decodeSignedTransferTransaction(flipByteAt(100));
    expect(verifyTransferTransactionSignature(tamperedSigR)).toBe(false);

    const tamperedSigS = decodeSignedTransferTransaction(flipByteAt(140));
    expect(verifyTransferTransactionSignature(tamperedSigS)).toBe(false);
  });

  it("never throws on invalid signature or public key bytes in verifyTransferTransactionSignature", () => {
    const signed = buildSignedSample();
    const decoded = decodeSignedTransferTransaction(signed.rawTxBytes);

    expect(
      verifyTransferTransactionSignature({
        ...decoded,
        signature: new Uint8Array(64).fill(0xff),
      }),
    ).toBe(false);

    expect(
      verifyTransferTransactionSignature(decoded, new Uint8Array(32).fill(0xff)),
    ).toBe(false);

    expect(verifyTransferTransactionSignature(decoded, new Uint8Array(16))).toBe(false);
    expect(
      verifyTransferTransactionSignature({
        ...decoded,
        signature: new Uint8Array(32),
      }),
    ).toBe(false);
    expect(
      verifyTransferTransactionSignature({
        ...decoded,
        signingHash: new Uint8Array(16),
      }),
    ).toBe(false);
    expect(
      verifyTransferTransactionSignature(
        null as unknown as ReturnType<typeof decodeSignedTransferTransaction>,
      ),
    ).toBe(false);
  });

  it("rejects wrong TransactionKind variant discriminant (including a signed Call tx) with KovanicaDecodeError(INVALID_VARIANT)", () => {
    const signedCall = signCallContractTransaction({
      sender: publicKey,
      secretKey: privateKey,
      call: {
        contract: recipientBytes,
        method: "name_register",
        args: buildNameRegisterCall("alice.kvnc", recipientBytes, ["https://relay.kovanica.org"]),
      },
      nonce: 1n,
      fee: 1_000n,
    });

    expect(() => decodeSignedTransferTransaction(signedCall.rawTxBytes)).toThrow(
      KovanicaDecodeError,
    );
    try {
      decodeSignedTransferTransaction(signedCall.rawTxBytes);
    } catch (err) {
      expect(err).toBeInstanceOf(KovanicaDecodeError);
      expect((err as KovanicaDecodeError).code).toBe("INVALID_VARIANT");
    }

    const signed = buildSignedSample();
    const wrongVariant = new Uint8Array(signed.rawTxBytes);
    new DataView(wrongVariant.buffer).setUint32(40, TRANSFER_TX_VARIANT + 1, true);

    expect(() => decodeSignedTransferTransaction(wrongVariant)).toThrow(KovanicaDecodeError);
    try {
      decodeSignedTransferTransaction(wrongVariant);
    } catch (err) {
      expect(err).toBeInstanceOf(KovanicaDecodeError);
      expect((err as KovanicaDecodeError).code).toBe("INVALID_VARIANT");
    }
  });

  it("rejects truncated bytes with KovanicaDecodeError(TRUNCATED)", () => {
    const signed = buildSignedSample();

    for (const cutLen of [0, 12, 32, 41, 95, signed.rawTxBytes.length - 1]) {
      const truncated = signed.rawTxBytes.slice(0, cutLen);
      expect(() => decodeSignedTransferTransaction(truncated)).toThrow(KovanicaDecodeError);
      try {
        decodeSignedTransferTransaction(truncated);
      } catch (err) {
        expect(err).toBeInstanceOf(KovanicaDecodeError);
        expect((err as KovanicaDecodeError).code).toBe("TRUNCATED");
      }
    }
  });

  it("rejects trailing bytes with KovanicaDecodeError(TRAILING_BYTES)", () => {
    const signed = buildSignedSample();
    const withTrailing = new Uint8Array(signed.rawTxBytes.length + 4);
    withTrailing.set(signed.rawTxBytes, 0);
    withTrailing.set([0xde, 0xad, 0xbe, 0xef], signed.rawTxBytes.length);

    expect(() => decodeSignedTransferTransaction(withTrailing)).toThrow(KovanicaDecodeError);
    try {
      decodeSignedTransferTransaction(withTrailing);
    } catch (err) {
      expect(err).toBeInstanceOf(KovanicaDecodeError);
      expect((err as KovanicaDecodeError).code).toBe("TRAILING_BYTES");
    }
  });

  it("rejects invalid hex strings with KovanicaDecodeError(INVALID_INPUT)", () => {
    for (const badInput of ["not-hex", "0xzz11", "0x123", "abc"]) {
      expect(() => decodeSignedTransferTransaction(badInput)).toThrow(KovanicaDecodeError);
      try {
        decodeSignedTransferTransaction(badInput);
      } catch (err) {
        expect(err).toBeInstanceOf(KovanicaDecodeError);
        expect((err as KovanicaDecodeError).code).toBe("INVALID_INPUT");
      }
    }
  });
});
