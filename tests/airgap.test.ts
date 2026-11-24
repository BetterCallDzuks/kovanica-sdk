import { describe, expect, it } from "vitest";
import { ADDRESS_PREFIX, TESTNET_ADDRESS_PREFIX, encodeAddress } from "../src/address";
import {
  AIRGAP_ENVELOPE_PREFIX,
  AIRGAP_ENVELOPE_VERSION,
  MULTISIG_BUNDLE_FORMAT,
  MULTISIG_BUNDLE_VERSION,
  checkMultisigQuorum,
  decodeAirgapTxEnvelope,
  decodeMultisigProposalBundle,
  encodeAirgapTxEnvelope,
  encodeMultisigProposalBundle,
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

function makePro21Address(fillByte: number, prefix = ADDRESS_PREFIX): string {
  return encodeAddress(new Uint8Array(32).fill(fillByte), prefix);
}

const MULTISIG_ADDR = makePro21Address(0x10);
const SIGNER_1 = makePro21Address(0x21);
const SIGNER_2 = makePro21Address(0x22);
const SIGNER_3 = makePro21Address(0x23);
const OUTSIDER = makePro21Address(0x99);
const TESTNET_MULTISIG_ADDR = makePro21Address(0x30, TESTNET_ADDRESS_PREFIX);
const TESTNET_SIGNER_1 = makePro21Address(0x31, TESTNET_ADDRESS_PREFIX);
const TESTNET_SIGNER_2 = makePro21Address(0x32, TESTNET_ADDRESS_PREFIX);

const SIG_1 = `0x${"11".repeat(64)}`;
const SIG_2 = `0x${"22".repeat(64)}`;
const SIG_3 = `0x${"33".repeat(64)}`;

describe("Air-Gapped Multisig Quorum Checker & Proposal Bundle", () => {
  describe("checkMultisigQuorum", () => {
    it("computes quorum accurately below, at, and above threshold", () => {
      const below = checkMultisigQuorum({
        signers: [SIGNER_1, SIGNER_2, SIGNER_3],
        approvals: [SIGNER_1],
        threshold: 2,
      });
      expect(below).toEqual({
        quorumReached: false,
        approvedCount: 1,
        threshold: 2,
        remainingNeeded: 1,
        uniqueSigners: [SIGNER_1, SIGNER_2, SIGNER_3],
        validApprovals: [SIGNER_1],
        unknownApprovals: [],
        duplicateApprovals: [],
      });

      const at = checkMultisigQuorum({
        signers: [SIGNER_1, SIGNER_2, SIGNER_3],
        approvals: [SIGNER_1, SIGNER_3],
        threshold: 2,
      });
      expect(at.quorumReached).toBe(true);
      expect(at.approvedCount).toBe(2);
      expect(at.remainingNeeded).toBe(0);
      expect(at.validApprovals).toEqual([SIGNER_1, SIGNER_3]);

      const above = checkMultisigQuorum({
        signers: [SIGNER_1, SIGNER_2, SIGNER_3],
        approvals: [SIGNER_1, SIGNER_2, SIGNER_3],
        threshold: 2,
      });
      expect(above.quorumReached).toBe(true);
      expect(above.approvedCount).toBe(3);
      expect(above.remainingNeeded).toBe(0);
    });

    it("deduplicates signers and separates valid, unknown, and duplicate approvals", () => {
      const result = checkMultisigQuorum({
        signers: [`  ${SIGNER_1}  `, SIGNER_2, SIGNER_1, SIGNER_3],
        approvals: [
          SIGNER_1,
          ` ${SIGNER_1} `,
          SIGNER_1,
          OUTSIDER,
          OUTSIDER,
          "not-a-valid-address",
        ],
        threshold: 2,
      });

      expect(result.quorumReached).toBe(false);
      expect(result.approvedCount).toBe(1);
      expect(result.remainingNeeded).toBe(1);
      expect(result.uniqueSigners).toEqual([SIGNER_1, SIGNER_2, SIGNER_3]);
      expect(result.validApprovals).toEqual([SIGNER_1]);
      expect(result.unknownApprovals).toEqual([OUTSIDER, "not-a-valid-address"]);
      expect(result.duplicateApprovals).toEqual([SIGNER_1, OUTSIDER]);
    });

    it("supports Testnet PRO-21 (tknc...dag) signers and approvals", () => {
      const result = checkMultisigQuorum({
        signers: [TESTNET_SIGNER_1, TESTNET_SIGNER_2],
        approvals: [TESTNET_SIGNER_1, TESTNET_SIGNER_2],
        threshold: 2,
      });
      expect(result.quorumReached).toBe(true);
      expect(result.uniqueSigners).toEqual([TESTNET_SIGNER_1, TESTNET_SIGNER_2]);
      expect(result.validApprovals).toEqual([TESTNET_SIGNER_1, TESTNET_SIGNER_2]);
    });

    it("rejects invalid PRO-21 signers (malformed, legacy hex, empty)", () => {
      expect(() =>
        checkMultisigQuorum({
          signers: [],
          approvals: [],
          threshold: 1,
        }),
      ).toThrow(KovanicaDecodeError);

      expect(() =>
        checkMultisigQuorum({
          signers: [SIGNER_1, "kvncinvalidaddressdag"],
          approvals: [],
          threshold: 1,
        }),
      ).toThrow(KovanicaDecodeError);

      // Legacy 32-byte hex is not a PRO-21 address
      expect(() =>
        checkMultisigQuorum({
          signers: [SIGNER_1, `0x${"aa".repeat(32)}`],
          approvals: [],
          threshold: 1,
        }),
      ).toThrow(KovanicaDecodeError);
    });

    it("rejects invalid thresholds (<= 0, > uniqueSigners.length, non-integer)", () => {
      for (const badThreshold of [0, -1, 3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() =>
          checkMultisigQuorum({
            signers: [SIGNER_1, SIGNER_2, SIGNER_1],
            approvals: [SIGNER_1],
            threshold: badThreshold,
          }),
        ).toThrow(KovanicaDecodeError);
      }
    });
  });

  describe("encodeMultisigProposalBundle / decodeMultisigProposalBundle", () => {
    it("round-trips a Mainnet bundle with payloadHex + description and computes quorum", () => {
      const encoded = encodeMultisigProposalBundle({
        version: MULTISIG_BUNDLE_VERSION,
        chainId: CHAIN_IDS.MAINNET,
        multisigAddress: MULTISIG_ADDR,
        proposalId: "prop-2026-001",
        threshold: 2,
        signers: [SIGNER_3, SIGNER_1, SIGNER_2],
        approvals: [
          {
            signer: SIGNER_2,
            signatureHex: SIG_2.toUpperCase(),
            signedAtMs: 1700000002000,
          },
          {
            signer: SIGNER_1,
            signatureHex: SIG_1.slice(2), // no 0x prefix normalized on encode
            signedAtMs: 1700000001000,
          },
        ],
        payloadHex: "0XDEADBEEF",
        description: "Treasury transfer 100 KVNC",
      });

      const parsedRaw = JSON.parse(encoded) as Record<string, unknown>;
      expect(parsedRaw.format).toBe(MULTISIG_BUNDLE_FORMAT);
      expect(parsedRaw.version).toBe(MULTISIG_BUNDLE_VERSION);

      const { bundle, quorum } = decodeMultisigProposalBundle(encoded);
      expect(bundle).toEqual({
        format: MULTISIG_BUNDLE_FORMAT,
        version: MULTISIG_BUNDLE_VERSION,
        chainId: CHAIN_IDS.MAINNET,
        multisigAddress: MULTISIG_ADDR,
        proposalId: "prop-2026-001",
        threshold: 2,
        signers: [SIGNER_1, SIGNER_2, SIGNER_3].sort(),
        approvals: [
          { signer: SIGNER_1, signatureHex: SIG_1, signedAtMs: 1700000001000 },
          { signer: SIGNER_2, signatureHex: SIG_2, signedAtMs: 1700000002000 },
        ].sort((a, b) => (a.signer < b.signer ? -1 : 1)),
        payloadHex: "0xdeadbeef",
        description: "Treasury transfer 100 KVNC",
      });
      expect(quorum.quorumReached).toBe(true);
      expect(quorum.approvedCount).toBe(2);
      expect(quorum.remainingNeeded).toBe(0);
    });

    it("produces deterministic JSON regardless of signer/approval ordering or hex case", () => {
      const encodedA = encodeMultisigProposalBundle({
        chainId: CHAIN_IDS.DEVNET,
        multisigAddress: MULTISIG_ADDR,
        proposalId: "prop-det-1",
        threshold: 2,
        signers: [SIGNER_2, SIGNER_1, SIGNER_3],
        approvals: [
          { signer: SIGNER_3, signatureHex: SIG_3.toUpperCase() },
          { signer: SIGNER_1, signatureHex: SIG_1 },
        ],
        description: "Deterministic bundle test",
      });

      const encodedB = encodeMultisigProposalBundle({
        version: 1,
        chainId: CHAIN_IDS.DEVNET,
        multisigAddress: `  ${MULTISIG_ADDR}  `,
        proposalId: "  prop-det-1  ",
        threshold: 2,
        signers: [SIGNER_1, SIGNER_3, SIGNER_2, SIGNER_1],
        approvals: [
          { signer: SIGNER_1, signatureHex: SIG_1.slice(2).toUpperCase() },
          { signer: SIGNER_3, signatureHex: SIG_3 },
        ],
        description: "  Deterministic bundle test  ",
      });

      expect(encodedA).toBe(encodedB);
    });

    it("supports Testnet (chain 2) tknc...dag addresses and rejects tknc...dag on Mainnet (chain 1)", () => {
      const encoded = encodeMultisigProposalBundle({
        chainId: CHAIN_IDS.TESTNET,
        multisigAddress: TESTNET_MULTISIG_ADDR,
        proposalId: "prop-testnet-1",
        threshold: 2,
        signers: [TESTNET_SIGNER_1, TESTNET_SIGNER_2],
        approvals: [{ signer: TESTNET_SIGNER_1, signatureHex: SIG_1 }],
        payloadHex: "0x01020304",
      });

      const { bundle, quorum } = decodeMultisigProposalBundle(encoded);
      expect(bundle.chainId).toBe(CHAIN_IDS.TESTNET);
      expect(quorum.quorumReached).toBe(false);
      expect(quorum.remainingNeeded).toBe(1);

      expect(() =>
        encodeMultisigProposalBundle({
          chainId: CHAIN_IDS.MAINNET,
          multisigAddress: TESTNET_MULTISIG_ADDR,
          proposalId: "prop-mainnet-reject-tknc",
          threshold: 1,
          signers: [SIGNER_1],
          approvals: [],
          description: "Should fail",
        }),
      ).toThrow(KovanicaDecodeError);
    });

    it("rejects malformed JSON, unsupported format/version, invalid chainId, and bad hex", () => {
      expect(() => decodeMultisigProposalBundle("")).toThrow(KovanicaDecodeError);
      expect(() => decodeMultisigProposalBundle("{not-json")).toThrow(KovanicaDecodeError);
      expect(() => decodeMultisigProposalBundle("[]")).toThrow(KovanicaDecodeError);

      const validEncoded = encodeMultisigProposalBundle({
        chainId: CHAIN_IDS.MAINNET,
        multisigAddress: MULTISIG_ADDR,
        proposalId: "prop-1",
        threshold: 1,
        signers: [SIGNER_1],
        approvals: [{ signer: SIGNER_1, signatureHex: SIG_1 }],
        payloadHex: "0xabcd",
      });
      const validObj = JSON.parse(validEncoded) as Record<string, unknown>;

      // Unsupported format
      expect(() =>
        decodeMultisigProposalBundle(
          JSON.stringify({ ...validObj, format: "kovanica-multisig-bundle-v2" }),
        ),
      ).toThrow(KovanicaDecodeError);

      // Unsupported version
      expect(() =>
        decodeMultisigProposalBundle(JSON.stringify({ ...validObj, version: 2 })),
      ).toThrow(KovanicaDecodeError);

      // Unsupported chainId
      expect(() =>
        decodeMultisigProposalBundle(JSON.stringify({ ...validObj, chainId: 99 })),
      ).toThrow(KovanicaDecodeError);

      // Bad signature hex (too short)
      expect(() =>
        decodeMultisigProposalBundle(
          JSON.stringify({
            ...validObj,
            approvals: [{ signer: SIGNER_1, signatureHex: "0x1234" }],
          }),
        ),
      ).toThrow(KovanicaDecodeError);

      // Bad signature hex (uppercase on strict decode)
      expect(() =>
        decodeMultisigProposalBundle(
          JSON.stringify({
            ...validObj,
            approvals: [{ signer: SIGNER_1, signatureHex: `0x${"AA".repeat(64)}` }],
          }),
        ),
      ).toThrow(KovanicaDecodeError);

      // Bad payloadHex (odd length)
      expect(() =>
        decodeMultisigProposalBundle(
          JSON.stringify({ ...validObj, payloadHex: "0xabc" }),
        ),
      ).toThrow(KovanicaDecodeError);

      // Missing both payloadHex and description
      const { payloadHex: _omitted, ...withoutPayload } = validObj;
      expect(() =>
        decodeMultisigProposalBundle(JSON.stringify(withoutPayload)),
      ).toThrow(KovanicaDecodeError);
    });

    it("enforces zero secret material guarantee on both encode and decode", () => {
      const baseProposal = {
        chainId: CHAIN_IDS.MAINNET,
        multisigAddress: MULTISIG_ADDR,
        proposalId: "prop-secret-check",
        threshold: 1,
        signers: [SIGNER_1],
        approvals: [{ signer: SIGNER_1, signatureHex: SIG_1 }],
        description: "No secrets allowed",
      };

      const secretPayloads: Array<Record<string, unknown>> = [
        { ...baseProposal, privateKey: "0xdeadbeef" },
        { ...baseProposal, private_key: "0xdeadbeef" },
        { ...baseProposal, secretKey: "0xdeadbeef" },
        { ...baseProposal, mnemonic: "abandon abandon abandon" },
        { ...baseProposal, seedPhrase: "abandon abandon abandon" },
        { ...baseProposal, passphrase: "secret" },
        { ...baseProposal, keystore: "{}" },
        {
          ...baseProposal,
          approvals: [
            { signer: SIGNER_1, signatureHex: SIG_1, privateKey: "0x00" },
          ],
        },
      ];

      for (const bad of secretPayloads) {
        expect(() =>
          encodeMultisigProposalBundle(
            bad as unknown as Parameters<typeof encodeMultisigProposalBundle>[0],
          ),
        ).toThrow(KovanicaDecodeError);

        const withHeader = {
          format: MULTISIG_BUNDLE_FORMAT,
          version: MULTISIG_BUNDLE_VERSION,
          ...bad,
        };
        expect(() =>
          decodeMultisigProposalBundle(JSON.stringify(withHeader)),
        ).toThrow(KovanicaDecodeError);
      }
    });
  });
});
