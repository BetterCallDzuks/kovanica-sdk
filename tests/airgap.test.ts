import { describe, expect, it } from "vitest";
import {
  AIRGAP_ENVELOPE_PREFIX,
  AIRGAP_ENVELOPE_VERSION,
  decodeAirgapTxEnvelope,
  encodeAirgapTxEnvelope,
} from "../src/airgap";
import { CHAIN_IDS, NETWORK_TAGS } from "../src/chains";
import { KovanicaDecodeError } from "../src/decoders";

const SAMPLE_RAW_TX_HEX = "deadbeef0102030405060708090a0b0c";
const SAMPLE_SIGNING_HASH_HEX = "AB".repeat(32);

describe("Air-Gapped Tx Envelope Encoder/Decoder", () => {
  describe("round-trip encode/decode", () => {
    it("round-trips Chain 1 (Mainnet) via kvnc-tx:v1:... and auto-fills canonical networkTag", () => {
      const { envelope, encoded } = encodeAirgapTxEnvelope({
        chainId: CHAIN_IDS.MAINNET,
        kind: "transfer",
        rawTxHex: `0X${SAMPLE_RAW_TX_HEX.toUpperCase()}`,
        signingHashHex: SAMPLE_SIGNING_HASH_HEX,
      });

      expect(encoded.startsWith(AIRGAP_ENVELOPE_PREFIX)).toBe(true);
      expect(envelope.version).toBe(AIRGAP_ENVELOPE_VERSION);
      expect(envelope.chainId).toBe(1);
      expect(envelope.networkTag).toBe(NETWORK_TAGS.MAINNET);
      expect(envelope.kind).toBe("transfer");
      expect(envelope.rawTxHex).toBe(`0x${SAMPLE_RAW_TX_HEX}`);
      expect(envelope.signingHashHex).toBe(`0x${"ab".repeat(32)}`);
      expect(envelope.checksumHex).toMatch(/^[0-9a-f]{16}$/);

      const decoded = decodeAirgapTxEnvelope(encoded, {
        expectedChainId: CHAIN_IDS.MAINNET,
      });
      expect(decoded).toEqual(envelope);
    });

    it("round-trips Chain 2 (Testnet) via kvnc-tx:v1:... and raw JSON", () => {
      const { envelope, encoded } = encodeAirgapTxEnvelope({
        chainId: CHAIN_IDS.TESTNET,
        kind: "call",
        rawTxHex: SAMPLE_RAW_TX_HEX,
      });

      expect(envelope.chainId).toBe(2);
      expect(envelope.networkTag).toBe(NETWORK_TAGS.TESTNET);
      expect(envelope.signingHashHex).toBeUndefined();

      const fromEncoded = decodeAirgapTxEnvelope(encoded, {
        expectedChainId: CHAIN_IDS.TESTNET,
      });
      expect(fromEncoded).toEqual(envelope);

      const fromJson = decodeAirgapTxEnvelope(JSON.stringify(envelope), {
        expectedChainId: CHAIN_IDS.TESTNET,
      });
      expect(fromJson).toEqual(envelope);
    });

    it("accepts explicit canonical networkTag on Chain 1 & Chain 2 and supports kind='raw'", () => {
      const { envelope, encoded } = encodeAirgapTxEnvelope({
        chainId: CHAIN_IDS.MAINNET,
        networkTag: NETWORK_TAGS.MAINNET,
        kind: "raw",
        rawTxHex: "0x0102",
      });

      expect(decodeAirgapTxEnvelope(`  ${encoded}\n`)).toEqual(envelope);
    });

    it("decodes raw JSON regardless of key order", () => {
      const { envelope } = encodeAirgapTxEnvelope({
        chainId: CHAIN_IDS.MAINNET,
        kind: "transfer",
        rawTxHex: "0x1234",
      });

      const reorderedJson = JSON.stringify({
        checksumHex: envelope.checksumHex,
        rawTxHex: envelope.rawTxHex,
        kind: envelope.kind,
        networkTag: envelope.networkTag,
        chainId: envelope.chainId,
        version: envelope.version,
      });

      expect(decodeAirgapTxEnvelope(reorderedJson)).toEqual(envelope);
    });
  });

  describe("tampering fails closed with KovanicaDecodeError", () => {
    it("rejects tampered chainId (even with matching canonical networkTag for new chain)", () => {
      const { envelope } = encodeAirgapTxEnvelope({
        chainId: CHAIN_IDS.MAINNET,
        kind: "transfer",
        rawTxHex: `0x${SAMPLE_RAW_TX_HEX}`,
      });

      const tampered = {
        ...envelope,
        chainId: CHAIN_IDS.TESTNET,
        networkTag: NETWORK_TAGS.TESTNET,
      };

      expect(() => decodeAirgapTxEnvelope(JSON.stringify(tampered))).toThrow(
        KovanicaDecodeError,
      );
    });

    it("rejects tampered rawTxHex", () => {
      const { envelope } = encodeAirgapTxEnvelope({
        chainId: CHAIN_IDS.MAINNET,
        kind: "call",
        rawTxHex: `0x${SAMPLE_RAW_TX_HEX}`,
      });

      const tampered = {
        ...envelope,
        rawTxHex: `0x${SAMPLE_RAW_TX_HEX.slice(0, -2)}ff`,
      };

      expect(() => decodeAirgapTxEnvelope(JSON.stringify(tampered))).toThrow(
        KovanicaDecodeError,
      );
    });

    it("rejects tampered checksumHex", () => {
      const { envelope } = encodeAirgapTxEnvelope({
        chainId: CHAIN_IDS.TESTNET,
        kind: "transfer",
        rawTxHex: `0x${SAMPLE_RAW_TX_HEX}`,
      });

      const flippedFirstNibble = envelope.checksumHex[0] === "0" ? "1" : "0";
      const tampered = {
        ...envelope,
        checksumHex: `${flippedFirstNibble}${envelope.checksumHex.slice(1)}`,
      };

      expect(() => decodeAirgapTxEnvelope(JSON.stringify(tampered))).toThrow(
        KovanicaDecodeError,
      );
    });

    it("rejects tampered signingHashHex or kind", () => {
      const { envelope } = encodeAirgapTxEnvelope({
        chainId: CHAIN_IDS.MAINNET,
        kind: "transfer",
        rawTxHex: `0x${SAMPLE_RAW_TX_HEX}`,
        signingHashHex: `0x${"11".repeat(32)}`,
      });

      expect(() =>
        decodeAirgapTxEnvelope(
          JSON.stringify({ ...envelope, signingHashHex: `0x${"22".repeat(32)}` }),
        ),
      ).toThrow(KovanicaDecodeError);

      expect(() =>
        decodeAirgapTxEnvelope(JSON.stringify({ ...envelope, kind: "call" })),
      ).toThrow(KovanicaDecodeError);
    });
  });

  describe("networkTag spoofing protection", () => {
    it("rejects spoofed networkTag on Chain 1 & Chain 2 during encode", () => {
      expect(() =>
        encodeAirgapTxEnvelope({
          chainId: CHAIN_IDS.MAINNET,
          networkTag: NETWORK_TAGS.TESTNET,
          kind: "transfer",
          rawTxHex: "0xabcd",
        }),
      ).toThrow(KovanicaDecodeError);

      expect(() =>
        encodeAirgapTxEnvelope({
          chainId: CHAIN_IDS.TESTNET,
          networkTag: "2-0000000000000000",
          kind: "transfer",
          rawTxHex: "0xabcd",
        }),
      ).toThrow(KovanicaDecodeError);
    });

    it("rejects spoofed networkTag on Chain 1 & Chain 2 during decode", () => {
      const { envelope } = encodeAirgapTxEnvelope({
        chainId: CHAIN_IDS.MAINNET,
        kind: "transfer",
        rawTxHex: "0xabcd",
      });

      expect(() =>
        decodeAirgapTxEnvelope(
          JSON.stringify({ ...envelope, networkTag: "1-0000000000000000" }),
        ),
      ).toThrow(KovanicaDecodeError);

      expect(() =>
        decodeAirgapTxEnvelope(
          JSON.stringify({
            ...envelope,
            chainId: CHAIN_IDS.TESTNET,
            networkTag: NETWORK_TAGS.MAINNET,
          }),
        ),
      ).toThrow(KovanicaDecodeError);
    });
  });

  describe("expectedChainId enforcement", () => {
    it("rejects when decoded chainId does not match expectedChainId", () => {
      const { encoded } = encodeAirgapTxEnvelope({
        chainId: CHAIN_IDS.TESTNET,
        kind: "transfer",
        rawTxHex: "0xdeadbeef",
      });

      expect(() =>
        decodeAirgapTxEnvelope(encoded, { expectedChainId: CHAIN_IDS.MAINNET }),
      ).toThrow(KovanicaDecodeError);
    });
  });

  describe("malformed framing, base64url, prefix, and version", () => {
    it("rejects wrong prefix or empty input", () => {
      const { encoded } = encodeAirgapTxEnvelope({
        chainId: CHAIN_IDS.MAINNET,
        kind: "raw",
        rawTxHex: "0x01",
      });
      const b64 = encoded.slice(AIRGAP_ENVELOPE_PREFIX.length);

      expect(() => decodeAirgapTxEnvelope("")).toThrow(KovanicaDecodeError);
      expect(() => decodeAirgapTxEnvelope(`kvnc-tx:v2:${b64}`)).toThrow(
        KovanicaDecodeError,
      );
      expect(() => decodeAirgapTxEnvelope(`other:${b64}`)).toThrow(
        KovanicaDecodeError,
      );
    });

    it("rejects corrupted base64url payloads", () => {
      expect(() =>
        decodeAirgapTxEnvelope(`${AIRGAP_ENVELOPE_PREFIX}!!!not-base64!!!`),
      ).toThrow(KovanicaDecodeError);

      // Invalid base64url length (mod 4 === 1)
      expect(() =>
        decodeAirgapTxEnvelope(`${AIRGAP_ENVELOPE_PREFIX}a`),
      ).toThrow(KovanicaDecodeError);

      // Standard base64 with padding '=' is rejected
      expect(() =>
        decodeAirgapTxEnvelope(`${AIRGAP_ENVELOPE_PREFIX}e30=`),
      ).toThrow(KovanicaDecodeError);
    });

    it("rejects unsupported envelope version", () => {
      const { envelope } = encodeAirgapTxEnvelope({
        chainId: CHAIN_IDS.MAINNET,
        kind: "transfer",
        rawTxHex: "0x0102",
      });

      expect(() =>
        decodeAirgapTxEnvelope(JSON.stringify({ ...envelope, version: 2 })),
      ).toThrow(KovanicaDecodeError);

      expect(() =>
        decodeAirgapTxEnvelope(JSON.stringify({ ...envelope, version: 0 })),
      ).toThrow(KovanicaDecodeError);
    });

    it("rejects invalid hex inputs on encode", () => {
      expect(() =>
        encodeAirgapTxEnvelope({
          chainId: CHAIN_IDS.MAINNET,
          kind: "raw",
          rawTxHex: "0xabc", // odd length
        }),
      ).toThrow(KovanicaDecodeError);

      expect(() =>
        encodeAirgapTxEnvelope({
          chainId: CHAIN_IDS.MAINNET,
          kind: "raw",
          rawTxHex: "0x", // empty bytes
        }),
      ).toThrow(KovanicaDecodeError);

      expect(() =>
        encodeAirgapTxEnvelope({
          chainId: CHAIN_IDS.MAINNET,
          kind: "raw",
          rawTxHex: "0xabcd",
          signingHashHex: "0x1234", // not 32 bytes
        }),
      ).toThrow(KovanicaDecodeError);
    });
  });
});
