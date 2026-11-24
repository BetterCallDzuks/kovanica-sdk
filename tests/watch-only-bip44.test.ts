import { describe, expect, it } from "vitest";
import {
  BIP44_PURPOSE,
  CHAIN_IDS,
  DEV_COIN_TYPE,
  HARDENED_OFFSET,
  KOVANICA_COIN_TYPE,
  LEGACY_COIN_TYPE,
  TESTNET_ADDRESS_PREFIX,
  createWatchOnlyAccount,
  encodeAddress,
  parseBip44Path,
  validateBip44Path,
} from "../src/index";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const SAMPLE_PUBKEY_HEX = "862f70cfafc9b581699f8d67598eac699cbc92bdfc940e95ed7ee1e8d8100e7e";
const SAMPLE_PUBKEY = hexToBytes(SAMPLE_PUBKEY_HEX);
const VALID_MAINNET_ADDRESS = encodeAddress(SAMPLE_PUBKEY);
const VALID_TESTNET_ADDRESS = encodeAddress(SAMPLE_PUBKEY, TESTNET_ADDRESS_PREFIX);

describe("parseBip44Path and validateBip44Path", () => {
  it("parses standard BIP-44 Kovanica path m/44'/3007'/0'/0/0", () => {
    const parsed = parseBip44Path("m/44'/3007'/0'/0/0");
    expect(parsed).toEqual({
      purpose: BIP44_PURPOSE,
      coinType: KOVANICA_COIN_TYPE,
      account: 0,
      change: 0,
      addressIndex: 0,
      hardened: {
        purpose: true,
        coinType: true,
        account: true,
        change: false,
        addressIndex: false,
      },
      allHardened: false,
      normalized: "m/44'/3007'/0'/0/0",
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.hardened)).toBe(true);
  });

  it("parses Kovanica SLIP-0010 all-hardened BIP-44 path m/44'/3007'/2'/1'/42'", () => {
    const parsed = parseBip44Path("m/44'/3007'/2'/1'/42'");
    expect(parsed).toEqual({
      purpose: 44,
      coinType: 3007,
      account: 2,
      change: 1,
      addressIndex: 42,
      hardened: {
        purpose: true,
        coinType: true,
        account: true,
        change: true,
        addressIndex: true,
      },
      allHardened: true,
      normalized: "m/44'/3007'/2'/1'/42'",
    });
  });

  it("normalizes uppercase M/, h/H hardened markers, and surrounding whitespace", () => {
    const parsed = parseBip44Path("  M/44h/3007H/5h/0H/9'  ");
    expect(parsed.normalized).toBe("m/44'/3007'/5'/0'/9'");
    expect(parsed.allHardened).toBe(true);
    expect(parsed.account).toBe(5);
    expect(parsed.addressIndex).toBe(9);
  });

  it("accepts maximum valid unhardened index 2^31 - 1 (2147483647)", () => {
    const maxIdx = HARDENED_OFFSET - 1;
    const parsed = parseBip44Path(`m/44'/3007'/${maxIdx}'/1/${maxIdx}`);
    expect(parsed.account).toBe(maxIdx);
    expect(parsed.addressIndex).toBe(maxIdx);
    expect(parsed.normalized).toBe(`m/44'/3007'/${maxIdx}'/1/${maxIdx}`);
  });

  it("enforces requireAllHardened option for strict SLIP-0010 Ed25519 paths", () => {
    const valid = validateBip44Path("m/44'/3007'/0'/0'/0'", { requireAllHardened: true });
    expect(valid.valid).toBe(true);
    expect(valid.parsed?.allHardened).toBe(true);

    const unhardenedChange = validateBip44Path("m/44'/3007'/0'/0/0'", {
      requireAllHardened: true,
    });
    expect(unhardenedChange.valid).toBe(false);
    expect(unhardenedChange.error).toMatch(/hardened change/i);

    const unhardenedIndex = validateBip44Path("m/44'/3007'/0'/0'/0", {
      requireAllHardened: true,
    });
    expect(unhardenedIndex.valid).toBe(false);
    expect(unhardenedIndex.error).toMatch(/hardened addressIndex/i);
  });

  it("supports custom coinType options (single, list, or null for any)", () => {
    expect(validateBip44Path("m/44'/9999'/0'/0'/0'").valid).toBe(false);
    expect(validateBip44Path("m/44'/9999'/0'/0'/0'", { coinType: DEV_COIN_TYPE }).valid).toBe(true);
    expect(
      validateBip44Path("m/44'/1337'/0'/0'/0'", {
        coinType: [KOVANICA_COIN_TYPE, DEV_COIN_TYPE, LEGACY_COIN_TYPE],
      }).valid,
    ).toBe(true);
    expect(validateBip44Path("m/44'/60'/0'/0/0", { coinType: null }).valid).toBe(true);
  });

  it("supports strictChange option (0 or 1 only)", () => {
    expect(validateBip44Path("m/44'/3007'/0'/2/0").valid).toBe(true);
    const rejected = validateBip44Path("m/44'/3007'/0'/2/0", { strictChange: true });
    expect(rejected.valid).toBe(false);
    expect(rejected.error).toMatch(/change index/i);
    expect(validateBip44Path("m/44'/3007'/0'/1/0", { strictChange: true }).valid).toBe(true);
  });

  it("rejects invalid BIP-44 paths across structure, markers, ranges, purpose, and coin type", () => {
    const invalidCases: Array<[string, RegExp]> = [
      ["", /must not be empty/i],
      ["   ", /must not be empty/i],
      ["44'/3007'/0'/0/0", /must start with 'm\/'/i],
      ["x/44'/3007'/0'/0/0", /must start with 'm\/'/i],
      ["m/44'/3007'/0'", /exactly 5 derivation levels/i],
      ["m/44'/3007'/0'/0/0/0", /exactly 5 derivation levels/i],
      ["m/44'/3007'/0'/0/0/", /exactly 5 derivation levels/i],
      ["m/44'//3007'/0'/0/0", /exactly 5 derivation levels/i],
      ["m/44/3007'/0'/0/0", /purpose.*must be hardened/i],
      ["m/44'/3007/0'/0/0", /coinType.*must be hardened/i],
      ["m/44'/3007'/0/0/0", /account.*must be hardened/i],
      ["m/84'/3007'/0'/0/0", /purpose 84/i],
      ["m/44'/60'/0'/0/0", /coin type 60/i],
      ["m/44'/3007'/-1'/0/0", /invalid bip-44 account/i],
      ["m/44'/3007'/0'/-1/0", /invalid bip-44 change/i],
      ["m/44'/3007'/0'/0/-5", /invalid bip-44 addressIndex/i],
      ["m/44'/3007'/01'/0/0", /invalid bip-44 account/i],
      ["m/44'/3007'/abc'/0/0", /invalid bip-44 account/i],
      ["m/44'/3007'/0''/0/0", /invalid bip-44 account/i],
      ["m/44'/3007'/1.5'/0/0", /invalid bip-44 account/i],
      [`m/44'/3007'/${HARDENED_OFFSET}'/0/0`, /out of range/i],
      ["m/44'/3007'/0'/0/4294967295", /out of range/i],
      ["m/44'/3007'/0'/0/99999999999999999999", /out of range/i],
    ];

    for (const [badPath, expectedPattern] of invalidCases) {
      const res = validateBip44Path(badPath);
      expect(res.valid, `Expected "${badPath}" to be invalid`).toBe(false);
      expect(res.parsed).toBeUndefined();
      expect(res.error).toMatch(expectedPattern);
      expect(() => parseBip44Path(badPath)).toThrow(expectedPattern);
    }
  });

  it("handles non-string inputs safely in validateBip44Path without throwing", () => {
    const res = validateBip44Path(null as unknown as string);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/must be a string/i);
  });
});

describe("createWatchOnlyAccount", () => {
  it("creates an immutable watch-only account for a valid mainnet PRO-21 address", () => {
    const account = createWatchOnlyAccount(VALID_MAINNET_ADDRESS, CHAIN_IDS.MAINNET);

    expect(account).toEqual({
      address: VALID_MAINNET_ADDRESS,
      format: "pro21-mainnet",
      payloadHex: `0x${SAMPLE_PUBKEY_HEX}`,
      canonicalMainnet: VALID_MAINNET_ADDRESS,
      canonicalTestnet: VALID_TESTNET_ADDRESS,
      chainId: CHAIN_IDS.MAINNET,
      network: "mainnet",
      readOnly: true,
      isWatchOnly: true,
      canSign: false,
    });
    expect(Object.isFrozen(account)).toBe(true);
    expect(() => {
      (account as { canSign: boolean }).canSign = true;
    }).toThrow(TypeError);
  });

  it("infers mainnet/testnet chainId when chainId is omitted", () => {
    const mainnetAcc = createWatchOnlyAccount(`  ${VALID_MAINNET_ADDRESS}  `);
    expect(mainnetAcc.chainId).toBe(CHAIN_IDS.MAINNET);
    expect(mainnetAcc.network).toBe("mainnet");
    expect(mainnetAcc.address).toBe(VALID_MAINNET_ADDRESS);

    const testnetAcc = createWatchOnlyAccount(VALID_TESTNET_ADDRESS);
    expect(testnetAcc.chainId).toBe(CHAIN_IDS.TESTNET);
    expect(testnetAcc.network).toBe("testnet");
    expect(testnetAcc.address).toBe(VALID_TESTNET_ADDRESS);
  });

  it("supports valid testnet and devnet PRO-21 addresses", () => {
    const testnetTknc = createWatchOnlyAccount(VALID_TESTNET_ADDRESS, CHAIN_IDS.TESTNET);
    expect(testnetTknc.chainId).toBe(CHAIN_IDS.TESTNET);
    expect(testnetTknc.network).toBe("testnet");
    expect(testnetTknc.format).toBe("pro21-testnet");

    const testnetKvnc = createWatchOnlyAccount(VALID_MAINNET_ADDRESS, CHAIN_IDS.TESTNET);
    expect(testnetKvnc.chainId).toBe(CHAIN_IDS.TESTNET);
    expect(testnetKvnc.network).toBe("testnet");
    expect(testnetKvnc.format).toBe("pro21-mainnet");

    const devnetAcc = createWatchOnlyAccount(VALID_MAINNET_ADDRESS, CHAIN_IDS.DEVNET);
    expect(devnetAcc.chainId).toBe(CHAIN_IDS.DEVNET);
    expect(devnetAcc.network).toBe("devnet");
    expect(devnetAcc.format).toBe("pro21-mainnet");
  });

  it("contains zero private key material or signing capabilities", () => {
    const account = createWatchOnlyAccount(VALID_MAINNET_ADDRESS) as unknown as Record<
      string,
      unknown
    >;

    const forbiddenKeys = [
      "secretKey",
      "privateKey",
      "seed",
      "mnemonic",
      "passphrase",
      "sign",
      "signCallTransaction",
      "sendCallTransaction",
    ];
    for (const key of forbiddenKeys) {
      expect(key in account, `Watch-only account must not contain "${key}"`).toBe(false);
    }

    expect(account.readOnly).toBe(true);
    expect(account.isWatchOnly).toBe(true);
    expect(account.canSign).toBe(false);
  });

  it("rejects mismatched chainId, invalid addresses, and non-PRO-21 legacy hex addresses", () => {
    // Testnet tknc address on Mainnet or Devnet
    expect(() => createWatchOnlyAccount(VALID_TESTNET_ADDRESS, CHAIN_IDS.MAINNET)).toThrow(
      /only allowed on Testnet/i,
    );
    expect(() => createWatchOnlyAccount(VALID_TESTNET_ADDRESS, CHAIN_IDS.DEVNET)).toThrow(
      /only allowed on Testnet/i,
    );

    // Invalid chainId
    expect(() => createWatchOnlyAccount(VALID_MAINNET_ADDRESS, -1)).toThrow(/Invalid chain ID/i);
    expect(() => createWatchOnlyAccount(VALID_MAINNET_ADDRESS, 1.5)).toThrow(/Invalid chain ID/i);

    // Invalid / corrupted addresses
    expect(() => createWatchOnlyAccount("")).toThrow(/must not be empty/i);
    expect(() => createWatchOnlyAccount("not-an-address")).toThrow();
    const corrupted = `${VALID_MAINNET_ADDRESS.slice(0, -4)}0dag`;
    expect(() => createWatchOnlyAccount(corrupted)).toThrow();

    // Legacy hex rejected even on Devnet or without chainId (PRO-21 required)
    expect(() => createWatchOnlyAccount(`0x${SAMPLE_PUBKEY_HEX}`)).toThrow(
      /canonical PRO-21 address/i,
    );
    expect(() => createWatchOnlyAccount(`0x${SAMPLE_PUBKEY_HEX}`, CHAIN_IDS.DEVNET)).toThrow(
      /canonical PRO-21 address/i,
    );
    expect(() => createWatchOnlyAccount(`0x${SAMPLE_PUBKEY_HEX}`, CHAIN_IDS.MAINNET)).toThrow(
      /Legacy addresses are not allowed/i,
    );
  });
});
