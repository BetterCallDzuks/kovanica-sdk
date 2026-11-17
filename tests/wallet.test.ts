import { describe, expect, it } from "vitest";
import {
  BIP44_PURPOSE,
  DEV_COIN_TYPE,
  HARDENED_OFFSET,
  KOVANICA_COIN_TYPE,
  LEGACY_COIN_TYPE,
  TESTNET_ADDRESS_PREFIX,
  addressFromSeed,
  bip39Seed,
  decodeAddress,
  deriveBip44,
  deriveHardened,
  derivePath,
  encodeAddress,
  formatBip44Path,
  getPublicKey,
  isValidAddress,
  masterFromSeed,
  parseAddressForChain,
} from "../src/index";
import { CHAIN_IDS } from "../src/chains";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("SLIP-0010 HD Key Derivation (Ed25519)", () => {
  it("passes official SLIP-0010 Test Vector 1", () => {
    const seed = hexToBytes("000102030405060708090a0b0c0d0e0f");
    const master = masterFromSeed(seed);

    expect(bytesToHex(master.key)).toBe(
      "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7",
    );
    expect(bytesToHex(master.chainCode)).toBe(
      "90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb",
    );

    // Path m/0'
    const m0 = deriveHardened(master, HARDENED_OFFSET);
    expect(bytesToHex(m0.key)).toBe(
      "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3",
    );
    expect(bytesToHex(m0.chainCode)).toBe(
      "8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69",
    );

    // Path m/0'/1'
    const m01 = deriveHardened(m0, HARDENED_OFFSET + 1);
    expect(bytesToHex(m01.key)).toBe(
      "b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2",
    );
    expect(bytesToHex(m01.chainCode)).toBe(
      "a320425f77d1b5c2505a6b1b27382b37368ee640e3557c315416801243552f14",
    );

    // Path string derivation equivalence
    const fromPath = derivePath(master, "m/0'/1'");
    expect(bytesToHex(fromPath.key)).toBe(bytesToHex(m01.key));
    expect(bytesToHex(fromPath.chainCode)).toBe(bytesToHex(m01.chainCode));
  });

  it("passes official SLIP-0010 Test Vector 2", () => {
    const seed = hexToBytes(
      "fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542",
    );
    const master = masterFromSeed(seed);

    expect(bytesToHex(master.key)).toBe(
      "171cb88b1b3c1db25add599712e36245d75bc65a1a5c9e18d76f9f2b1eab4012",
    );
    expect(bytesToHex(master.chainCode)).toBe(
      "ef70a74db9c3a5af931b5fe73ed8e1a53464133654fd55e7a66f8570b8e33c3b",
    );

    // Path m/0'
    const m0 = deriveHardened(master, HARDENED_OFFSET);
    expect(bytesToHex(m0.key)).toBe(
      "1559eb2bbec5790b0c65d8693e4d0875b1747f4970ae8b650486ed7470845635",
    );
    expect(bytesToHex(m0.chainCode)).toBe(
      "0b78a3226f915c082bf118f83618a618ab6dec793752624cbeb622acb562862d",
    );
  });

  it("strictly rejects non-hardened child derivation for Ed25519", () => {
    const seed = new Uint8Array(32).fill(42);
    const master = masterFromSeed(seed);

    // Numeric index < 0x8000_0000
    expect(() => deriveHardened(master, 0)).toThrow(/does not support non-hardened/);

    // Path segment without hardening tick
    expect(() => derivePath(master, "m/44'/3007'/0'/0/0")).toThrow(
      /strictly requires hardened path segments/,
    );
  });

  it("verifies Vector T1 pubkey derivation from raw seed", () => {
    const rawSeed = new Uint8Array(32).fill(0x07);
    const pub = getPublicKey(rawSeed);
    expect(bytesToHex(pub)).toBe(
      "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c",
    );
  });

  it("matches golden BIP-39 + BIP-44 path m/44'/3007'/0'/0'/0' across L1 and web", () => {
    const phrase =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const seed64 = bip39Seed(phrase, "");
    const derived = addressFromSeed(seed64, 0, 0, 0, KOVANICA_COIN_TYPE);

    expect(derived.path).toBe("m/44'/3007'/0'/0'/0'");
    expect(bytesToHex(derived.publicKey)).toBe(
      "862f70cfafc9b581699f8d67598eac699cbc92bdfc940e95ed7ee1e8d8100e7e",
    );
    expect(derived.address).toBe(
      "kvncschhpna0ex6cz6vl34n4nr4vdxwtey4alj2qa90d0ms73kqspel0nuhe8dag",
    );

    // Address decodes back to the derived public key
    const decoded = decodeAddress(derived.address);
    expect(bytesToHex(decoded)).toBe(bytesToHex(derived.publicKey));
  });

  it("supports dev coin type 9999 and legacy coin type 1337 paths", () => {
    expect(KOVANICA_COIN_TYPE).toBe(3007);
    expect(DEV_COIN_TYPE).toBe(9999);
    expect(LEGACY_COIN_TYPE).toBe(1337);
    expect(BIP44_PURPOSE).toBe(44);

    expect(formatBip44Path(0, 0, 0, KOVANICA_COIN_TYPE)).toBe("m/44'/3007'/0'/0'/0'");
    expect(formatBip44Path(0, 0, 0, DEV_COIN_TYPE)).toBe("m/44'/9999'/0'/0'/0'");
    expect(formatBip44Path(0, 0, 0, LEGACY_COIN_TYPE)).toBe("m/44'/1337'/0'/0'/0'");

    const seed64 = bip39Seed("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", "");
    const devAccount = addressFromSeed(seed64, 0, 0, 0, DEV_COIN_TYPE);
    expect(devAccount.path).toBe("m/44'/9999'/0'/0'/0'");
    expect(devAccount.address.startsWith("kvnc")).toBe(true);
    expect(devAccount.address.endsWith("dag")).toBe(true);
  });

  it("derives distinct accounts for different account indices", () => {
    const seed64 = new Uint8Array(64).fill(7);
    const acc0 = addressFromSeed(seed64, 0, 0, 0);
    const acc1 = addressFromSeed(seed64, 1, 0, 0);
    const acc2 = addressFromSeed(seed64, 2, 0, 0);

    expect(acc0.address).not.toBe(acc1.address);
    expect(acc1.address).not.toBe(acc2.address);
    expect(bytesToHex(acc0.publicKey)).not.toBe(bytesToHex(acc1.publicKey));
  });

  it("supports tknc prefix for testnet and verifies address interoperability", () => {
    const pubkey = hexToBytes("862f70cfafc9b581699f8d67598eac699cbc92bdfc940e95ed7ee1e8d8100e7e");
    const testnetAddr = encodeAddress(pubkey, TESTNET_ADDRESS_PREFIX);

    expect(testnetAddr).toHaveLength(64);
    expect(testnetAddr.startsWith("tknc")).toBe(true);
    expect(testnetAddr.endsWith("dag")).toBe(true);

    // Decode with testnet prefix
    const decoded = decodeAddress(testnetAddr, TESTNET_ADDRESS_PREFIX);
    expect(bytesToHex(decoded)).toBe(bytesToHex(pubkey));

    // Decode without specifying prefix auto-detects tknc
    const autoDecoded = decodeAddress(testnetAddr);
    expect(bytesToHex(autoDecoded)).toBe(bytesToHex(pubkey));

    // parseAddressForChain on Testnet (chain 2) accepts tknc
    const parsedTestnet = parseAddressForChain(testnetAddr, CHAIN_IDS.TESTNET);
    expect(bytesToHex(parsedTestnet)).toBe(bytesToHex(pubkey));

    // parseAddressForChain on Mainnet (chain 1) rejects tknc
    expect(() => parseAddressForChain(testnetAddr, CHAIN_IDS.MAINNET)).toThrow();
    expect(isValidAddress(testnetAddr, CHAIN_IDS.MAINNET)).toBe(false);
    expect(isValidAddress(testnetAddr, CHAIN_IDS.TESTNET)).toBe(true);
  });
});
