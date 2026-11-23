import { describe, expect, it } from "vitest";
import { encodeAddress } from "../src/address";
import { CHAIN_IDS } from "../src/chains";
import {
  buildNameRegisterCall,
  signCallContractTransaction,
} from "../src/contracts";
import { KovanicaDecodeError } from "../src/decoders";
import {
  TRANSFER_TX_VARIANT,
  TRANSFER_TX_WIRE_SIZE,
  signTransferTransaction,
} from "../src/transfer-tx";
import {
  type DecodedSignedTransactionAuto,
  decodeSignedTransactionAuto,
  peekTransactionVariant,
  verifySignedTransactionAuto,
} from "../src/tx-auto-decode";
import { getPublicKey } from "../src/wallet";

function makeDeterministicBytes(len: number, seed: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = (seed + i * 37) & 0xff;
  }
  return out;
}

describe("tx-auto-decode: peekTransactionVariant, decodeSignedTransactionAuto & verifySignedTransactionAuto", () => {
  const secretKey = makeDeterministicBytes(32, 0x21);
  const publicKey = getPublicKey(secretKey);
  const recipientBytes = makeDeterministicBytes(32, 0x63);
  const recipientAddress = encodeAddress(recipientBytes);
  const contractBytes = makeDeterministicBytes(32, 0x44);
  const callArgs = buildNameRegisterCall(
    "auto.kvnc",
    makeDeterministicBytes(32, 0x88),
    ["https://relay.kovanica.org"],
  );

  function buildSignedTransfer(chainId: bigint | number = CHAIN_IDS.MAINNET) {
    return signTransferTransaction({
      privateKey: secretKey,
      to: recipientAddress,
      amount: 5_000_000_000n,
      nonce: 11n,
      fee: 2_000n,
      chainId,
    });
  }

  function buildSignedCall(chainId: number = CHAIN_IDS.MAINNET) {
    return signCallContractTransaction({
      sender: publicKey,
      secretKey,
      call: {
        contract: contractBytes,
        method: "name_register",
        args: callArgs,
        call_value: 100_000n,
        gas_limit: 200_000n,
      },
      nonce: 12n,
      fee: 15_000n,
      chainId,
    });
  }

  it("auto-decodes and verifies a signed Transfer tx from both Uint8Array and 0x-prefixed hex", () => {
    const signed = buildSignedTransfer();

    expect(peekTransactionVariant(signed.rawTxBytes)).toBe(TRANSFER_TX_VARIANT);
    expect(peekTransactionVariant(`0x${signed.rawTxHex}`)).toBe(TRANSFER_TX_VARIANT);
    expect(peekTransactionVariant(signed.rawTxHex)).toBe(TRANSFER_TX_VARIANT);

    const decodedFromBytes = decodeSignedTransactionAuto(signed.rawTxBytes);
    const decodedFromHex = decodeSignedTransactionAuto(`0x${signed.rawTxHex}`);

    expect(decodedFromHex).toEqual(decodedFromBytes);
    expect(decodedFromBytes.kind).toBe("transfer");
    expect(decodedFromBytes.variant).toBe(0);

    if (decodedFromBytes.kind !== "transfer") {
      throw new Error("Expected transfer variant");
    }
    expect(decodedFromBytes.tx.senderBytes).toEqual(publicKey);
    expect(decodedFromBytes.tx.recipientBytes).toEqual(recipientBytes);
    expect(decodedFromBytes.tx.recipientAddress).toBe(recipientAddress);
    expect(decodedFromBytes.tx.amount).toBe(5_000_000_000n);
    expect(decodedFromBytes.tx.nonce).toBe(11n);
    expect(decodedFromBytes.tx.fee).toBe(2_000n);
    expect(decodedFromBytes.tx.wireSizeBytes).toBe(TRANSFER_TX_WIRE_SIZE);

    expect(verifySignedTransactionAuto(decodedFromBytes)).toBe(true);
    expect(verifySignedTransactionAuto(decodedFromHex)).toBe(true);
    expect(verifySignedTransactionAuto(decodedFromBytes, publicKey)).toBe(true);

    const otherPubkey = getPublicKey(makeDeterministicBytes(32, 0xaa));
    expect(verifySignedTransactionAuto(decodedFromBytes, otherPubkey)).toBe(false);
  });

  it("auto-decodes and verifies a signed Call tx from both Uint8Array and 0x-prefixed hex", () => {
    const signed = buildSignedCall();

    expect(peekTransactionVariant(signed.rawTxBytes)).toBe(6);
    expect(peekTransactionVariant(`0x${signed.rawTxHex}`)).toBe(6);

    const decodedFromBytes = decodeSignedTransactionAuto(signed.rawTxBytes);
    const decodedFromHex = decodeSignedTransactionAuto(`0x${signed.rawTxHex}`);

    expect(decodedFromHex).toEqual(decodedFromBytes);
    expect(decodedFromBytes.kind).toBe("call");
    expect(decodedFromBytes.variant).toBe(6);

    if (decodedFromBytes.kind !== "call") {
      throw new Error("Expected call variant");
    }
    expect(decodedFromBytes.tx.senderBytes).toEqual(publicKey);
    expect(decodedFromBytes.tx.contractBytes).toEqual(contractBytes);
    expect(decodedFromBytes.tx.method).toBe("name_register");
    expect(decodedFromBytes.tx.args).toEqual(callArgs);
    expect(decodedFromBytes.tx.callValue).toBe(100_000n);
    expect(decodedFromBytes.tx.gasLimit).toBe(200_000n);
    expect(decodedFromBytes.tx.nonce).toBe(12n);
    expect(decodedFromBytes.tx.fee).toBe(15_000n);

    expect(verifySignedTransactionAuto(decodedFromBytes)).toBe(true);
    expect(verifySignedTransactionAuto(decodedFromHex)).toBe(true);
    expect(verifySignedTransactionAuto(decodedFromBytes, publicKey)).toBe(true);

    const otherPubkey = getPublicKey(makeDeterministicBytes(32, 0xbb));
    expect(verifySignedTransactionAuto(decodedFromBytes, otherPubkey)).toBe(false);
  });

  it("supports custom chainId (number and bigint) for both Transfer and Call transactions", () => {
    const signedTransfer = buildSignedTransfer(BigInt(CHAIN_IDS.TESTNET));
    const decodedTransfer = decodeSignedTransactionAuto(signedTransfer.rawTxBytes, {
      chainId: BigInt(CHAIN_IDS.TESTNET),
    });
    expect(verifySignedTransactionAuto(decodedTransfer)).toBe(true);
    expect(
      verifySignedTransactionAuto(
        decodeSignedTransactionAuto(signedTransfer.rawTxBytes, { chainId: CHAIN_IDS.MAINNET }),
      ),
    ).toBe(false);

    const signedCall = buildSignedCall(CHAIN_IDS.TESTNET);
    const decodedCall = decodeSignedTransactionAuto(signedCall.rawTxBytes, {
      chainId: BigInt(CHAIN_IDS.TESTNET),
    });
    expect(verifySignedTransactionAuto(decodedCall)).toBe(true);
    expect(
      verifySignedTransactionAuto(
        decodeSignedTransactionAuto(signedCall.rawTxBytes, { chainId: CHAIN_IDS.MAINNET }),
      ),
    ).toBe(false);
  });

  it("returns false from verifySignedTransactionAuto when Transfer or Call bytes are tampered", () => {
    const signedTransfer = buildSignedTransfer();
    const tamperedTransferBytes = new Uint8Array(signedTransfer.rawTxBytes);
    // Flip a bit in Transfer amount (offset 76)
    tamperedTransferBytes[76] = tamperedTransferBytes[76]! ^ 0x01;
    const decodedTamperedTransfer = decodeSignedTransactionAuto(tamperedTransferBytes);
    expect(decodedTamperedTransfer.kind).toBe("transfer");
    expect(verifySignedTransactionAuto(decodedTamperedTransfer)).toBe(false);

    const signedCall = buildSignedCall();
    const tamperedCallBytes = new Uint8Array(signedCall.rawTxBytes);
    // Flip a bit in Call nonce (offset 32)
    tamperedCallBytes[32] = tamperedCallBytes[32]! ^ 0x01;
    const decodedTamperedCall = decodeSignedTransactionAuto(tamperedCallBytes);
    expect(decodedTamperedCall.kind).toBe("call");
    expect(verifySignedTransactionAuto(decodedTamperedCall)).toBe(false);
  });

  it("never throws on invalid objects or malformed signature/publicKey bytes in verifySignedTransactionAuto", () => {
    const decodedTransfer = decodeSignedTransactionAuto(buildSignedTransfer().rawTxBytes);
    expect(verifySignedTransactionAuto(decodedTransfer, new Uint8Array(16))).toBe(false);
    expect(verifySignedTransactionAuto(decodedTransfer, new Uint8Array(32).fill(0xff))).toBe(
      false,
    );
    expect(
      verifySignedTransactionAuto(null as unknown as DecodedSignedTransactionAuto),
    ).toBe(false);
    expect(
      verifySignedTransactionAuto({
        kind: "unknown",
        variant: 99,
        tx: {},
      } as unknown as DecodedSignedTransactionAuto),
    ).toBe(false);
  });

  it("throws KovanicaDecodeError(INVALID_VARIANT) on unsupported variant discriminants", () => {
    const signed = buildSignedTransfer();

    for (const badVariant of [1, 2, 5, 7, 999]) {
      const mutated = new Uint8Array(signed.rawTxBytes);
      new DataView(mutated.buffer).setUint32(40, badVariant, true);

      expect(peekTransactionVariant(mutated)).toBe(badVariant);
      expect(() => decodeSignedTransactionAuto(mutated)).toThrow(KovanicaDecodeError);
      try {
        decodeSignedTransactionAuto(mutated);
      } catch (err) {
        expect(err).toBeInstanceOf(KovanicaDecodeError);
        expect((err as KovanicaDecodeError).code).toBe("INVALID_VARIANT");
        expect((err as KovanicaDecodeError).offset).toBe(40);
      }
    }
  });

  it("throws KovanicaDecodeError(TRUNCATED) on truncated bytes", () => {
    const signed = buildSignedTransfer();

    for (const cutLen of [0, 1, 31, 32, 40, 43]) {
      const truncated = signed.rawTxBytes.slice(0, cutLen);
      expect(() => peekTransactionVariant(truncated)).toThrow(KovanicaDecodeError);
      try {
        peekTransactionVariant(truncated);
      } catch (err) {
        expect(err).toBeInstanceOf(KovanicaDecodeError);
        expect((err as KovanicaDecodeError).code).toBe("TRUNCATED");
      }

      expect(() => decodeSignedTransactionAuto(truncated)).toThrow(KovanicaDecodeError);
      try {
        decodeSignedTransactionAuto(truncated);
      } catch (err) {
        expect(err).toBeInstanceOf(KovanicaDecodeError);
        expect((err as KovanicaDecodeError).code).toBe("TRUNCATED");
      }
    }

    // Truncated after variant (44..195 bytes) still fails in the dispatched decoder
    const truncatedAfterVariant = signed.rawTxBytes.slice(0, 60);
    expect(peekTransactionVariant(truncatedAfterVariant)).toBe(TRANSFER_TX_VARIANT);
    expect(() => decodeSignedTransactionAuto(truncatedAfterVariant)).toThrow(KovanicaDecodeError);
    try {
      decodeSignedTransactionAuto(truncatedAfterVariant);
    } catch (err) {
      expect(err).toBeInstanceOf(KovanicaDecodeError);
      expect((err as KovanicaDecodeError).code).toBe("TRUNCATED");
    }
  });

  it("throws KovanicaDecodeError(INVALID_INPUT) on invalid hex strings", () => {
    for (const badInput of ["not-hex", "0xzz11", "0x123", "abc"]) {
      expect(() => peekTransactionVariant(badInput)).toThrow(KovanicaDecodeError);
      try {
        peekTransactionVariant(badInput);
      } catch (err) {
        expect(err).toBeInstanceOf(KovanicaDecodeError);
        expect((err as KovanicaDecodeError).code).toBe("INVALID_INPUT");
      }

      expect(() => decodeSignedTransactionAuto(badInput)).toThrow(KovanicaDecodeError);
      try {
        decodeSignedTransactionAuto(badInput);
      } catch (err) {
        expect(err).toBeInstanceOf(KovanicaDecodeError);
        expect((err as KovanicaDecodeError).code).toBe("INVALID_INPUT");
      }
    }
  });
});
