import { describe, expect, it } from "vitest";
import {
  ADDRESS_PREFIX,
  TESTNET_ADDRESS_PREFIX,
  encodeAddress,
  legacyChecksum,
} from "../src/address";
import {
  inspectAddress,
  normalizeAddressList,
} from "../src/address-inspect";
import { CHAIN_IDS } from "../src/chains";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("address-inspect", () => {
  const sampleKey = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    sampleKey[i] = i + 1;
  }

  const otherKey = new Uint8Array(32).fill(0xab);

  const sampleHexBare = toHex(sampleKey);
  const sampleHex0x = `0x${sampleHexBare}`;
  const sampleMainnet = encodeAddress(sampleKey, ADDRESS_PREFIX);
  const sampleTestnet = encodeAddress(sampleKey, TESTNET_ADDRESS_PREFIX);
  const otherMainnet = encodeAddress(otherKey, ADDRESS_PREFIX);
  const otherTestnet = encodeAddress(otherKey, TESTNET_ADDRESS_PREFIX);

  describe("inspectAddress — valid formats without chain constraint", () => {
    it("inspects a valid kvnc...dag PRO-21 mainnet address", () => {
      const res = inspectAddress(`  ${sampleMainnet}  `);
      expect(res).toEqual({
        valid: true,
        input: `  ${sampleMainnet}  `,
        format: "pro21-mainnet",
        checksumValid: true,
        payloadHex: sampleHex0x,
        canonicalMainnet: sampleMainnet,
        canonicalTestnet: sampleTestnet,
        chainAllowed: null,
      });
    });

    it("inspects a valid tknc...dag PRO-21 testnet address", () => {
      const res = inspectAddress(sampleTestnet);
      expect(res).toEqual({
        valid: true,
        input: sampleTestnet,
        format: "pro21-testnet",
        checksumValid: true,
        payloadHex: sampleHex0x,
        canonicalMainnet: sampleMainnet,
        canonicalTestnet: sampleTestnet,
        chainAllowed: null,
      });
    });

    it("inspects valid bare 64-hex and 0x-prefixed 64-hex legacy addresses", () => {
      const bare = inspectAddress(sampleHexBare.toUpperCase());
      expect(bare).toEqual({
        valid: true,
        input: sampleHexBare.toUpperCase(),
        format: "legacy-hex",
        checksumValid: false,
        payloadHex: sampleHex0x,
        canonicalMainnet: sampleMainnet,
        canonicalTestnet: sampleTestnet,
        chainAllowed: null,
      });

      const prefixed = inspectAddress(sampleHex0x);
      expect(prefixed).toEqual({
        valid: true,
        input: sampleHex0x,
        format: "legacy-hex",
        checksumValid: false,
        payloadHex: sampleHex0x,
        canonicalMainnet: sampleMainnet,
        canonicalTestnet: sampleTestnet,
        chainAllowed: null,
      });
    });

    it("inspects valid legacy kvnc<72 hex>dag checksummed address", () => {
      const check = legacyChecksum(sampleKey);
      const legacyChecked = `kvnc${sampleHexBare}${toHex(check)}dag`;
      const res = inspectAddress(legacyChecked);
      expect(res.valid).toBe(true);
      expect(res.format).toBe("legacy-hex");
      expect(res.checksumValid).toBe(true);
      expect(res.payloadHex).toBe(sampleHex0x);
      expect(res.canonicalMainnet).toBe(sampleMainnet);
      expect(res.canonicalTestnet).toBe(sampleTestnet);
      expect(res.chainAllowed).toBeNull();
    });
  });

  describe("inspectAddress — corrupted checksums and arbitrary invalid inputs", () => {
    it("rejects corrupted PRO-21 mainnet and testnet checksums without throwing", () => {
      const flippedMainnetChar = sampleMainnet[12] === "q" ? "p" : "q";
      const corruptedMainnet =
        sampleMainnet.slice(0, 12) + flippedMainnetChar + sampleMainnet.slice(13);

      const resMain = inspectAddress(corruptedMainnet);
      expect(resMain.valid).toBe(false);
      expect(resMain.format).toBe("invalid");
      expect(resMain.checksumValid).toBe(false);
      expect(resMain.chainAllowed).toBeNull();
      expect(resMain.error).toMatch(/checksum mismatch/i);

      const flippedTestnetChar = sampleTestnet[12] === "q" ? "p" : "q";
      const corruptedTestnet =
        sampleTestnet.slice(0, 12) + flippedTestnetChar + sampleTestnet.slice(13);

      const resTest = inspectAddress(corruptedTestnet, CHAIN_IDS.TESTNET);
      expect(resTest.valid).toBe(false);
      expect(resTest.format).toBe("invalid");
      expect(resTest.checksumValid).toBe(false);
      expect(resTest.chainAllowed).toBe(false);
      expect(resTest.error).toMatch(/checksum mismatch/i);
    });

    it("never throws on empty, garbage, short, or uppercase 0X inputs", () => {
      const badInputs = [
        "",
        "   ",
        "not-an-address",
        "kvnctooshortdag",
        `0X${sampleHexBare}`,
        "0x1234",
        "kvnc" + "z".repeat(57) + "dag",
      ];

      for (const bad of badInputs) {
        const res = inspectAddress(bad);
        expect(res.valid).toBe(false);
        expect(res.format).toBe("invalid");
        expect(res.checksumValid).toBe(false);
        expect(res.chainAllowed).toBeNull();
        expect(res.error).toBeTruthy();
      }
    });
  });

  describe("inspectAddress — chain policy enforcement", () => {
    it("rejects legacy 64-hex on Chain 1 (Mainnet) and Chain 2 (Testnet), allows on Chain 3 (Devnet)", () => {
      const onMainnet = inspectAddress(sampleHex0x, CHAIN_IDS.MAINNET);
      expect(onMainnet.valid).toBe(false);
      expect(onMainnet.format).toBe("legacy-hex");
      expect(onMainnet.chainAllowed).toBe(false);
      expect(onMainnet.canonicalMainnet).toBe(sampleMainnet);
      expect(onMainnet.error).toMatch(/not allowed on chain 1/i);

      const onTestnet = inspectAddress(sampleHexBare, BigInt(CHAIN_IDS.TESTNET));
      expect(onTestnet.valid).toBe(false);
      expect(onTestnet.format).toBe("legacy-hex");
      expect(onTestnet.chainAllowed).toBe(false);
      expect(onTestnet.error).toMatch(/not allowed on chain 2/i);

      const onDevnet = inspectAddress(sampleHex0x, CHAIN_IDS.DEVNET);
      expect(onDevnet.valid).toBe(true);
      expect(onDevnet.format).toBe("legacy-hex");
      expect(onDevnet.chainAllowed).toBe(true);
      expect(onDevnet.error).toBeUndefined();

      const onDevnetBigInt = inspectAddress(sampleHexBare, 3n);
      expect(onDevnetBigInt.valid).toBe(true);
      expect(onDevnetBigInt.chainAllowed).toBe(true);
    });

    it("enforces kvnc...dag and tknc...dag chain policy accurately", () => {
      // kvnc...dag is allowed on Mainnet (1), Testnet (2), and Devnet (3)
      expect(inspectAddress(sampleMainnet, 1).chainAllowed).toBe(true);
      expect(inspectAddress(sampleMainnet, 2n).chainAllowed).toBe(true);
      expect(inspectAddress(sampleMainnet, 3).chainAllowed).toBe(true);

      // tknc...dag is allowed on Testnet (2) and rejected on Mainnet (1) and Devnet (3)
      const tkncOnTestnet = inspectAddress(sampleTestnet, CHAIN_IDS.TESTNET);
      expect(tkncOnTestnet.valid).toBe(true);
      expect(tkncOnTestnet.chainAllowed).toBe(true);

      const tkncOnMainnet = inspectAddress(sampleTestnet, CHAIN_IDS.MAINNET);
      expect(tkncOnMainnet.valid).toBe(false);
      expect(tkncOnMainnet.format).toBe("pro21-testnet");
      expect(tkncOnMainnet.checksumValid).toBe(true);
      expect(tkncOnMainnet.chainAllowed).toBe(false);
      expect(tkncOnMainnet.error).toMatch(/only allowed on Testnet/i);

      const tkncOnDevnet = inspectAddress(sampleTestnet, CHAIN_IDS.DEVNET);
      expect(tkncOnDevnet.valid).toBe(false);
      expect(tkncOnDevnet.chainAllowed).toBe(false);
    });
  });

  describe("normalizeAddressList", () => {
    it("deduplicates equivalent kvnc...dag, tknc...dag, and 0x hex addresses in order while collecting invalids", () => {
      const result = normalizeAddressList([
        sampleMainnet,
        sampleHex0x,
        "invalid-addr",
        otherMainnet,
        sampleTestnet,
        sampleHexBare,
        "",
      ]);

      expect(result.valid).toEqual([sampleMainnet, otherMainnet]);
      expect(result.invalid).toHaveLength(2);
      expect(result.invalid[0].input).toBe("invalid-addr");
      expect(result.invalid[0].error).toBeTruthy();
      expect(result.invalid[1].input).toBe("");
      expect(result.invalid[1].error).toBeTruthy();
    });

    it("respects expectedChainId and preferTestnetPrefix options", () => {
      const testnetResult = normalizeAddressList(
        [sampleMainnet, sampleTestnet, sampleHex0x, otherTestnet],
        {
          expectedChainId: CHAIN_IDS.TESTNET,
          preferTestnetPrefix: true,
        },
      );

      expect(testnetResult.valid).toEqual([sampleTestnet, otherTestnet]);
      expect(testnetResult.invalid).toHaveLength(1);
      expect(testnetResult.invalid[0].input).toBe(sampleHex0x);
      expect(testnetResult.invalid[0].error).toMatch(/not allowed on chain 2/i);

      const devnetResult = normalizeAddressList(
        [sampleHex0x, sampleMainnet, otherMainnet],
        { expectedChainId: 3n },
      );

      expect(devnetResult.valid).toEqual([sampleMainnet, otherMainnet]);
      expect(devnetResult.invalid).toEqual([]);
    });
  });
});
