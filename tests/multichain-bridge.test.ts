import { describe, expect, it } from "vitest";
import {
  BRIDGE_CHAINS,
  getBridgeChainById,
  getBridgeChainFamily,
  validateExternalBridgeAddress,
} from "../src";

describe("Multi-Chain Bridge Registry (BTC + Solana + All EVM)", () => {
  it("includes Bitcoin, Solana, and major EVM chains plus custom EVM fallback", () => {
    expect(BRIDGE_CHAINS.length).toBeGreaterThanOrEqual(12);
    expect(getBridgeChainFamily(0)).toBe("bitcoin");
    expect(getBridgeChainFamily(501)).toBe("solana");
    expect(getBridgeChainFamily(1)).toBe("evm");
    expect(getBridgeChainFamily(8453)).toBe("evm");
    expect(getBridgeChainFamily(42161)).toBe("evm");
    expect(getBridgeChainFamily(137)).toBe("evm");
    expect(getBridgeChainFamily(56)).toBe("evm");
    expect(getBridgeChainFamily(999999)).toBe("evm");
    expect(getBridgeChainById(999999).name).toBe("EVM Chain #999999");
  });

  it("validates Bitcoin, Solana, and EVM destination addresses", () => {
    expect(validateExternalBridgeAddress(0, "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBe(true);
    expect(validateExternalBridgeAddress(0, "0x1111111111111111111111111111111111111111")).toBe(false);
    expect(validateExternalBridgeAddress(501, "So11111111111111111111111111111111111111112")).toBe(true);
    expect(validateExternalBridgeAddress(501, "bad")).toBe(false);
    expect(validateExternalBridgeAddress(8453, "0x1111111111111111111111111111111111111111")).toBe(true);
    expect(validateExternalBridgeAddress(8453, "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBe(false);
  });
});
