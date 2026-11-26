import { describe, expect, it } from "vitest";
import {
  STEALTH_DOMAIN_NONCE,
  STEALTH_DOMAIN_SCAN_KEY,
  STEALTH_DOMAIN_SPEND_KEY,
  STEALTH_DOMAIN_TAG,
  STEALTH_DOMAIN_TWEAK,
  STEALTH_META_ADDRESS_PREFIX,
  TESTNET_ADDRESS_PREFIX,
  createStealthMeta,
  deriveOnetimeAddress,
  deriveOnetimeSpendKey,
  deriveStealthKeypairFromMnemonic,
  formatStealthMetaAddress,
  generateStealthKeypair,
  hexToBytes,
  isValidStealthMetaAddress,
  matchStealthAnnouncement,
  parseStealthMetaAddress,
  scanStealthAnnouncements,
  signSighashWithStealthScalar,
  verifyEd25519,
} from "../src/index";

// Golden cross-compatibility vector generated directly from
// `kovanica-web/src/lib/protocol/stealth.ts` (@noble/ed25519 + @noble/hashes).
const WEB_GOLDEN_VECTOR = {
  mnemonic:
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  ephemeralScalar: 42n,
  sighashHex: "ab".repeat(32),
  kp: {
    scanPrivkeyHex: "7c9055a628c43fc353211365f9821b4f5998d8b9f2dddbd6873031f61e5b8d05",
    scanPubkeyHex: "9f7ddb0c6da6a943a9cb46bda258e5b730c1a3159773be7b24a8389c171f6e8f",
    spendPrivkeyHex: "e1178733b2884f1a962d1f24677c7dbcd80ac785f9a32f92f1b0bd36fa720608",
    spendPubkeyHex: "4f525df902f9456000d99425165d03fc5318feacd48480377f1879030b72b4f5",
    metaAddress:
      "st:kvnc:9f7ddb0c6da6a943a9cb46bda258e5b730c1a3159773be7b24a8389c171f6e8f:4f525df902f9456000d99425165d03fc5318feacd48480377f1879030b72b4f5",
  },
  onetime: {
    address: "kvncjp4h0yhv4h4jrss0d5mck5llp7lxrceedss924c7fxfasssmdtmcde7kydag",
    addressHex: "906b7792ecadeb21c20f6d378b53ff0fbe61e3396c2055571e4993d8421b6af7",
    ephemeralPubkeyHex: "ce1a32994e835c193e2bf33909f44373ae2cf94ddef0fd922035c483670637c2",
    viewTag: "5060",
  },
  spend: {
    oneTimeScalarHex: "e9f7e12c38e9eed393dd841ff1504fb2351ece1ef1baa1be5a5d397f89a26d0e",
    address: "kvncjp4h0yhv4h4jrss0d5mck5llp7lxrceedss924c7fxfasssmdtmcde7kydag",
    addressHex: "906b7792ecadeb21c20f6d378b53ff0fbe61e3396c2055571e4993d8421b6af7",
    viewTag: "5060",
  },
  sig: {
    signatureHex:
      "ec869a144fee578b9d9b58f68d69c52470ff9f67e1907a9bbc92012fa392d64e44d2c02e8ab0003e858742f3e44c6e6a2d75e0437216fd9f331459e277b5bf0d",
    publicKeyHex: "906b7792ecadeb21c20f6d378b53ff0fbe61e3396c2055571e4993d8421b6af7",
  },
};

// Known Ed25519 identity and small-order points (RFC 8032 / cofactor 8)
const ED25519_IDENTITY_HEX = "01" + "00".repeat(31);
const ED25519_ORDER_2_HEX = "ec" + "ff".repeat(30) + "7f";
const ED25519_ORDER_4_HEX = "00".repeat(32);

describe("KVP-103 Dual-Key Ed25519 Stealth Addresses", () => {
  it("exports canonical KVP-103 domain separator constants", () => {
    expect(STEALTH_META_ADDRESS_PREFIX).toBe("st:kvnc:");
    expect(STEALTH_DOMAIN_TWEAK).toBe("KVNC/stealth/tweak/v1");
    expect(STEALTH_DOMAIN_TAG).toBe("KVNC/stealth/tag/v1");
    expect(STEALTH_DOMAIN_NONCE).toBe("KVNC/stealth/nonce/v1");
    expect(STEALTH_DOMAIN_SCAN_KEY).toBe("KVNC/stealth/scan/v1");
    expect(STEALTH_DOMAIN_SPEND_KEY).toBe("KVNC/stealth/spend/v1");
  });

  it("matches kovanica-web KVP-103 golden vector bit-for-bit across all stages", () => {
    // 1. Deterministic stealth keypair from mnemonic
    const kp = deriveStealthKeypairFromMnemonic(WEB_GOLDEN_VECTOR.mnemonic);
    expect(kp).toEqual(WEB_GOLDEN_VECTOR.kp);

    // 2. Deterministic one-time stealth address derivation (bigint override matches kovanica-web)
    const onetime = deriveOnetimeAddress(kp.metaAddress, WEB_GOLDEN_VECTOR.ephemeralScalar);
    expect(onetime).toEqual(WEB_GOLDEN_VECTOR.onetime);

    // Also works with options object form
    const onetimeOpts = deriveOnetimeAddress(kp.metaAddress, {
      ephemeralScalar: WEB_GOLDEN_VECTOR.ephemeralScalar,
    });
    expect(onetimeOpts).toEqual(WEB_GOLDEN_VECTOR.onetime);

    // 3. Watch-only announcement matching (scanPriv + spendPub only)
    const matched = matchStealthAnnouncement(kp.scanPrivkeyHex, kp.spendPubkeyHex, {
      ephemeralPubkeyHex: onetime.ephemeralPubkeyHex,
      viewTag: onetime.viewTag,
      stealthAddress: onetime.address,
    });
    expect(matched).toEqual({
      matched: true,
      address: WEB_GOLDEN_VECTOR.onetime.address,
      addressHex: WEB_GOLDEN_VECTOR.onetime.addressHex,
      viewTag: WEB_GOLDEN_VECTOR.onetime.viewTag,
    });

    // 4. One-time spend key recovery
    const spend = deriveOnetimeSpendKey({
      scanPrivkeyHex: kp.scanPrivkeyHex,
      spendPrivkeyHex: kp.spendPrivkeyHex,
      ephemeralPubkeyHex: onetime.ephemeralPubkeyHex,
    });
    expect(spend).toEqual(WEB_GOLDEN_VECTOR.spend);

    // 5. RFC 8032 Ed25519 scalar signature
    const sig = signSighashWithStealthScalar(
      spend.oneTimeScalarHex,
      WEB_GOLDEN_VECTOR.sighashHex,
    );
    expect(sig).toEqual(WEB_GOLDEN_VECTOR.sig);

    // 6. Standard RFC 8032 Ed25519 verification
    const valid = verifyEd25519(
      hexToBytes(sig.signatureHex),
      hexToBytes(WEB_GOLDEN_VECTOR.sighashHex),
      hexToBytes(onetime.addressHex),
    );
    expect(valid).toBe(true);
  });

  it("completes random end-to-end ECDH: keygen -> derive -> watch-only scan -> spend signature verifies", () => {
    const recipient = generateStealthKeypair();
    const parsed = parseStealthMetaAddress(recipient.metaAddress);
    expect(parsed.scanPubkeyHex).toBe(recipient.scanPubkeyHex);
    expect(parsed.spendPubkeyHex).toBe(recipient.spendPubkeyHex);
    expect(isValidStealthMetaAddress(recipient.metaAddress)).toBe(true);

    // Sender derives two unlinkable one-time L1 addresses
    const onetimeA = deriveOnetimeAddress(recipient.metaAddress);
    const onetimeB = deriveOnetimeAddress(recipient.metaAddress);
    expect(onetimeA.address.startsWith("kvnc") && onetimeA.address.endsWith("dag")).toBe(true);
    expect(onetimeA.addressHex).toHaveLength(64);
    expect(onetimeA.ephemeralPubkeyHex).toHaveLength(64);
    expect(onetimeA.viewTag).toHaveLength(4);
    expect(onetimeA.address).not.toBe(onetimeB.address);
    expect(onetimeA.ephemeralPubkeyHex).not.toBe(onetimeB.ephemeralPubkeyHex);

    // Recipient matches using ONLY (scanPriv, spendPub) — never spendPriv
    const match = matchStealthAnnouncement(recipient.scanPrivkeyHex, recipient.spendPubkeyHex, {
      ephemeralPubkeyHex: onetimeA.ephemeralPubkeyHex,
      viewTag: onetimeA.viewTag,
      stealthAddress: onetimeA.address,
    });
    expect(match.matched).toBe(true);
    if (match.matched) {
      expect(match.address).toBe(onetimeA.address);
      expect(match.addressHex).toBe(onetimeA.addressHex);
      expect(match.viewTag).toBe(onetimeA.viewTag);
    }

    // Wrong recipient must NOT match
    const bystander = generateStealthKeypair();
    const wrongMatch = matchStealthAnnouncement(
      bystander.scanPrivkeyHex,
      bystander.spendPubkeyHex,
      {
        ephemeralPubkeyHex: onetimeA.ephemeralPubkeyHex,
        viewTag: onetimeA.viewTag,
        stealthAddress: onetimeA.address,
      },
    );
    expect(wrongMatch.matched).toBe(false);

    // Recipient recovers one-time spend scalar and signs a 32-byte L1 sighash
    const spendKey = deriveOnetimeSpendKey({
      scanPrivkeyHex: recipient.scanPrivkeyHex,
      spendPrivkeyHex: recipient.spendPrivkeyHex,
      ephemeralPubkeyHex: onetimeA.ephemeralPubkeyHex,
    });
    expect(spendKey.address).toBe(onetimeA.address);
    expect(spendKey.addressHex).toBe(onetimeA.addressHex);

    const sighashHex = "cd".repeat(32);
    const { signatureHex, publicKeyHex } = signSighashWithStealthScalar(
      spendKey.oneTimeScalarHex,
      sighashHex,
    );
    expect(publicKeyHex).toBe(onetimeA.addressHex);
    expect(signatureHex).toHaveLength(128);

    expect(
      verifyEd25519(
        hexToBytes(signatureHex),
        hexToBytes(sighashHex),
        hexToBytes(onetimeA.addressHex),
      ),
    ).toBe(true);

    // Tampered sighash must fail verification
    expect(
      verifyEd25519(
        hexToBytes(signatureHex),
        hexToBytes("ce".repeat(32)),
        hexToBytes(onetimeA.addressHex),
      ),
    ).toBe(false);
  });

  it("normalizes mnemonics deterministically and rejects short phrases", () => {
    const a = deriveStealthKeypairFromMnemonic(WEB_GOLDEN_VECTOR.mnemonic);
    const b = deriveStealthKeypairFromMnemonic(
      `  ${WEB_GOLDEN_VECTOR.mnemonic.toUpperCase().replace(/ /g, "   ")}  `,
    );
    expect(a).toEqual(b);

    expect(() => deriveStealthKeypairFromMnemonic("abandon abandon abandon")).toThrow(
      /at least 12 words/,
    );
  });

  it("formats, parses, and validates meta-addresses while rejecting invalid and small-order points", () => {
    const { scanPubkeyHex, spendPubkeyHex, metaAddress } = WEB_GOLDEN_VECTOR.kp;

    expect(formatStealthMetaAddress(scanPubkeyHex.toUpperCase(), `0x${spendPubkeyHex}`)).toBe(
      metaAddress,
    );
    expect(createStealthMeta(scanPubkeyHex, spendPubkeyHex)).toEqual({
      scanPubkeyHex,
      spendPubkeyHex,
      metaAddress,
    });
    expect(parseStealthMetaAddress(`  ${metaAddress.toUpperCase().replace("ST:KVNC:", "st:kvnc:")}  `)).toEqual({
      scanPubkeyHex,
      spendPubkeyHex,
      metaAddress,
    });

    // Malformed strings
    expect(isValidStealthMetaAddress("not-a-meta-address")).toBe(false);
    expect(isValidStealthMetaAddress(`st:btc:${scanPubkeyHex}:${spendPubkeyHex}`)).toBe(false);
    expect(() => parseStealthMetaAddress("st:kvnc:abcd:1234")).toThrow(/Invalid stealth meta-address/);

    // Identity and small-order Ed25519 points must be rejected
    for (const badPoint of [ED25519_IDENTITY_HEX, ED25519_ORDER_2_HEX, ED25519_ORDER_4_HEX]) {
      expect(isValidStealthMetaAddress(`st:kvnc:${badPoint}:${spendPubkeyHex}`)).toBe(false);
      expect(isValidStealthMetaAddress(`st:kvnc:${scanPubkeyHex}:${badPoint}`)).toBe(false);
      expect(() => formatStealthMetaAddress(badPoint, spendPubkeyHex)).toThrow(
        /invalid or small-order curve point/,
      );
    }
  });

  it("handles view-tag fast-filtering, address checks, testnet prefixes, and batch scanning", () => {
    const recipient = deriveStealthKeypairFromMnemonic(WEB_GOLDEN_VECTOR.mnemonic);
    const bystander = generateStealthKeypair();

    const hit1 = deriveOnetimeAddress(recipient.metaAddress, {
      ephemeralScalar: 101n,
      addressPrefix: TESTNET_ADDRESS_PREFIX,
    });
    const hit2 = deriveOnetimeAddress(recipient.metaAddress, {
      ephemeralScalar: 202n,
      addressPrefix: TESTNET_ADDRESS_PREFIX,
    });
    const other = deriveOnetimeAddress(bystander.metaAddress, 303n);

    expect(hit1.address.startsWith("tknc") && hit1.address.endsWith("dag")).toBe(true);

    // Wrong view tag is rejected
    expect(
      matchStealthAnnouncement(recipient.scanPrivkeyHex, recipient.spendPubkeyHex, {
        ephemeralPubkeyHex: hit1.ephemeralPubkeyHex,
        viewTag: hit1.viewTag === "0000" ? "ffff" : "0000",
        stealthAddress: hit1.address,
      }).matched,
    ).toBe(false);

    // Wrong stealthAddressHex is rejected
    expect(
      matchStealthAnnouncement(recipient.scanPrivkeyHex, recipient.spendPubkeyHex, {
        ephemeralPubkeyHex: hit1.ephemeralPubkeyHex,
        viewTag: hit1.viewTag,
        stealthAddressHex: hit2.addressHex,
      }).matched,
    ).toBe(false);

    // Small-order or malformed ephemeral pubkey returns matched: false
    expect(
      matchStealthAnnouncement(recipient.scanPrivkeyHex, recipient.spendPubkeyHex, {
        ephemeralPubkeyHex: ED25519_IDENTITY_HEX,
      }).matched,
    ).toBe(false);
    expect(
      matchStealthAnnouncement(recipient.scanPrivkeyHex, recipient.spendPubkeyHex, {
        ephemeralPubkeyHex: "not-hex",
      }).matched,
    ).toBe(false);

    // Batch scanning deduplicates hits and preserves metadata
    const scanned = scanStealthAnnouncements({
      scanPrivkeyHex: recipient.scanPrivkeyHex,
      spendPubkeyHex: recipient.spendPubkeyHex,
      addressPrefix: TESTNET_ADDRESS_PREFIX,
      announcements: [
        {
          ephemeralPubkeyHex: other.ephemeralPubkeyHex,
          viewTag: other.viewTag,
          stealthAddress: other.address,
          txHash: "0xother",
        },
        {
          ephemeralPubkeyHex: hit1.ephemeralPubkeyHex,
          viewTag: hit1.viewTag,
          stealthAddress: hit1.address,
          txHash: "0xtx1",
          createdAt: "2026-11-26T00:00:00Z",
        },
        // Duplicate of hit1 should be deduplicated
        {
          ephemeralPubkeyHex: hit1.ephemeralPubkeyHex,
          viewTag: hit1.viewTag,
          stealthAddress: hit1.address,
          txHash: "0xtx1-dup",
        },
        // Invalid ephemeral pubkey should be skipped safely
        {
          ephemeralPubkeyHex: "zzzz",
        },
        {
          ephemeralPubkeyHex: hit2.ephemeralPubkeyHex,
          stealthAddressHex: `0x${hit2.addressHex}`,
          txHash: "0xtx2",
        },
      ],
    });

    expect(scanned).toHaveLength(2);
    expect(scanned[0]).toEqual({
      address: hit1.address,
      addressHex: hit1.addressHex,
      ephemeralPubkeyHex: hit1.ephemeralPubkeyHex,
      viewTag: hit1.viewTag,
      txHash: "0xtx1",
      createdAt: "2026-11-26T00:00:00Z",
    });
    expect(scanned[1]).toEqual({
      address: hit2.address,
      addressHex: hit2.addressHex,
      ephemeralPubkeyHex: hit2.ephemeralPubkeyHex,
      viewTag: hit2.viewTag,
      txHash: "0xtx2",
    });
  });

  it("rejects zero scalars and invalid sighash inputs", () => {
    expect(() => deriveOnetimeAddress(WEB_GOLDEN_VECTOR.kp.metaAddress, 0n)).toThrow(
      /Ephemeral scalar cannot be zero/,
    );
    expect(() => signSighashWithStealthScalar("00".repeat(32), "ab".repeat(32))).toThrow(
      /scalar cannot be zero/,
    );
    expect(() =>
      signSighashWithStealthScalar(WEB_GOLDEN_VECTOR.spend.oneTimeScalarHex, "xyz"),
    ).toThrow(/Invalid sighash hex string/);
    expect(() =>
      scanStealthAnnouncements({
        scanPrivkeyHex: "00".repeat(32),
        spendPubkeyHex: WEB_GOLDEN_VECTOR.kp.spendPubkeyHex,
        announcements: [],
      }),
    ).toThrow(/scalar cannot be zero/);
  });
});
