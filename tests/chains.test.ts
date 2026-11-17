import { describe, expect, it } from "vitest";
import {
  CHAIN_IDS,
  getChainConfig,
  isLegacyAddressAllowed,
  KNOWN_CHAINS,
  NETWORK_TAGS,
} from "../src/chains";

describe("chains configuration", () => {
  it("defines standard Kovanica chain IDs", () => {
    expect(CHAIN_IDS.MAINNET).toBe(1);
    expect(CHAIN_IDS.TESTNET).toBe(2);
    expect(CHAIN_IDS.HYBRID_TESTNET).toBe(2);
    expect(CHAIN_IDS.DEVNET).toBe(3);
    expect(NETWORK_TAGS.MAINNET).toBe("1-4d827d40dd9655db");
    expect(NETWORK_TAGS.TESTNET).toBe("2-acfdf6a6c80fd28a");
    expect("LOCAL" in CHAIN_IDS).toBe(false);
    expect("TESTNET_V2" in CHAIN_IDS).toBe(false);
    expect(KNOWN_CHAINS[4]).toBeUndefined();
    expect(getChainConfig(4)).toBeUndefined();
    expect(KNOWN_CHAINS[1337]).toBeUndefined();
    expect(getChainConfig(1337)).toBeUndefined();
  });

  it("retrieves chain config by chain ID", () => {
    const mainnet = getChainConfig(CHAIN_IDS.MAINNET);
    expect(mainnet).toBeDefined();
    expect(mainnet?.name).toBe("Mainnet");
    expect(mainnet?.ticker).toBe("KVNC");
    expect(mainnet?.decimals).toBe(9);
    expect(mainnet?.consensus).toBe("Hybrid PoW + GHOSTDAG");
    expect(mainnet?.ghostdagK).toBe(5);
    expect(mainnet?.networkTag).toBe("1-4d827d40dd9655db");
    expect(mainnet?.allowsLegacyAddress).toBe(false);

    const devnet = getChainConfig(CHAIN_IDS.DEVNET);
    expect(devnet).toBeDefined();
    expect(devnet?.name).toBe("Devnet");
    expect(devnet?.consensus).toBe("Mysticeti");
    expect(devnet?.ghostdagK).toBeUndefined();
    expect(devnet?.networkTag).toBeUndefined();
    expect(devnet?.allowsLegacyAddress).toBe(true);

    const testnet = getChainConfig(CHAIN_IDS.TESTNET);
    expect(testnet).toBeDefined();
    expect(testnet?.name).toBe("Testnet");
    expect(testnet?.consensus).toBe("Hybrid PoW + GHOSTDAG");
    expect(testnet?.targetBlockTimeMs).toBe(4000);
    expect(testnet?.ghostdagK).toBe(5);
    expect(testnet?.networkTag).toBe("2-acfdf6a6c80fd28a");
    expect(testnet?.allowsLegacyAddress).toBe(false);
  });

  it("accurately reports legacy address allowance", () => {
    expect(isLegacyAddressAllowed(1)).toBe(false);
    expect(isLegacyAddressAllowed(2)).toBe(false);
    expect(isLegacyAddressAllowed(3)).toBe(true);
    expect(isLegacyAddressAllowed(4)).toBe(false);
    expect(isLegacyAddressAllowed(5)).toBe(false);
    expect(isLegacyAddressAllowed(1337)).toBe(false);
    expect(isLegacyAddressAllowed(999)).toBe(false);
  });
});
