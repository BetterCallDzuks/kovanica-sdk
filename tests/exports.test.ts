import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as srcExports from "../src/index";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const distDir = resolve(pkgRoot, "dist");
const distEsmPath = resolve(distDir, "index.js");
const distCjsPath = resolve(distDir, "index.cjs");
const distDtsPath = resolve(distDir, "index.d.ts");
const distDctsPath = resolve(distDir, "index.d.cts");

type ExpectedRuntimeKind = "function" | "number" | "array";

const EXPECTED_PUBLIC_EXPORTS: ReadonlyArray<readonly [string, ExpectedRuntimeKind]> = [
  ["KovanicaClient", "function"],
  ["KovanicaWsClient", "function"],
  ["KovanicaWallet", "function"],
  ["HttpTransport", "function"],
  ["MAX_JSONRPC_BATCH_SIZE", "number"],
  ["DEFAULT_IDEMPOTENT_RPC_METHODS", "array"],
  ["computeRetryDelayMs", "function"],
  ["estimateAndBuildCall", "function"],
  ["estimateBatchCalls", "function"],
  ["dryRunCall", "function"],
  ["dryRunBatchCalls", "function"],
  ["waitForTransactionReceipt", "function"],
  ["readContractStorage", "function"],
  ["decodeContractLog", "function"],
  ["decodeTransactionReceiptLogs", "function"],
  ["NameRegistryClient", "function"],
  ["TokenClient", "function"],
  ["EscrowClient", "function"],
  ["HtlcClient", "function"],
  ["NftClient", "function"],
  ["VaultClient", "function"],
  ["MultisigClient", "function"],
  ["FailoverHttpTransport", "function"],
  ["createFailoverHttpTransport", "function"],
  ["createFailoverClient", "function"],
  ["sanitizeRpcUrl", "function"],
  ["applyFeeBuffer", "function"],
  ["estimateTxFeeWithBuffer", "function"],
  ["waitForTransactionFinality", "function"],
  ["decodeSignedCallTransaction", "function"],
  ["verifyCallTransactionSignature", "function"],
  ["verifyEd25519", "function"],
  ["probeRpcNode", "function"],
  ["signTransferTransaction", "function"],
  ["decodeSignedTransferTransaction", "function"],
  ["verifyTransferTransactionSignature", "function"],
  ["inspectAddress", "function"],
  ["normalizeAddressList", "function"],
  ["peekTransactionVariant", "function"],
  ["decodeSignedTransactionAuto", "function"],
  ["verifySignedTransactionAuto", "function"],
  ["encodeAirgapTxEnvelope", "function"],
  ["decodeAirgapTxEnvelope", "function"],
  ["parseMempoolFeeStats", "function"],
  ["computeFeeRecommendations", "function"],
  ["getAccountTxHistory", "function"],
  ["parseAccountTxHistoryEntry", "function"],
  ["DEFAULT_ACCOUNT_TX_HISTORY_MAX_PAGES", "number"],
];

function assertPublicExportSurface(mod: Record<string, unknown>, label: string): void {
  for (const [symbol, expectedKind] of EXPECTED_PUBLIC_EXPORTS) {
    expect(symbol in mod, `${label} should export "${symbol}"`).toBe(true);
    const value = mod[symbol];
    if (expectedKind === "array") {
      expect(Array.isArray(value), `${label}.${symbol} should be an array`).toBe(true);
      expect((value as unknown[]).length, `${label}.${symbol} should be non-empty`).toBeGreaterThan(0);
    } else if (expectedKind === "number") {
      expect(typeof value, `${label}.${symbol} should be a number`).toBe("number");
      expect(value as number, `${label}.${symbol} should be positive`).toBeGreaterThan(0);
    } else {
      expect(typeof value, `${label}.${symbol} should be a function`).toBe("function");
    }
  }
}

const hasDistArtifacts =
  existsSync(distEsmPath) && existsSync(distCjsPath) && existsSync(distDtsPath);

describe("kovanica-sdk public export surface", () => {
  it("exports all major public symbols with expected runtime types from src/index.ts", () => {
    assertPublicExportSurface(srcExports as Record<string, unknown>, "src/index.ts");
  });

  describe.runIf(hasDistArtifacts)("built dist/ artifacts (ESM, CJS, DTS)", () => {
    it("exports all major public symbols with expected runtime types from dist/index.js (ESM)", async () => {
      const esmMod = (await import(pathToFileURL(distEsmPath).href)) as Record<string, unknown>;
      assertPublicExportSurface(esmMod, "dist/index.js");
    });

    it("exports all major public symbols with expected runtime types from dist/index.cjs (CJS)", () => {
      const require = createRequire(import.meta.url);
      const cjsMod = require(distCjsPath) as Record<string, unknown>;
      assertPublicExportSurface(cjsMod, "dist/index.cjs");
    });

    it("maintains runtime export parity between dist/index.js (ESM) and dist/index.cjs (CJS)", async () => {
      const esmMod = (await import(pathToFileURL(distEsmPath).href)) as Record<string, unknown>;
      const require = createRequire(import.meta.url);
      const cjsMod = require(distCjsPath) as Record<string, unknown>;

      const esmKeys = Object.keys(esmMod)
        .filter((k) => k !== "default" && k !== "__esModule")
        .sort();
      const cjsKeys = Object.keys(cjsMod)
        .filter((k) => k !== "default" && k !== "__esModule")
        .sort();

      expect(cjsKeys).toEqual(esmKeys);
    });

    it("declares all major public symbols in dist/index.d.ts (and dist/index.d.cts when present)", () => {
      const dtsContent = readFileSync(distDtsPath, "utf8");
      for (const [symbol] of EXPECTED_PUBLIC_EXPORTS) {
        const declPattern = new RegExp(`\\b${symbol}\\b`);
        expect(declPattern.test(dtsContent), `dist/index.d.ts should declare "${symbol}"`).toBe(
          true,
        );
      }

      if (existsSync(distDctsPath)) {
        const dctsContent = readFileSync(distDctsPath, "utf8");
        for (const [symbol] of EXPECTED_PUBLIC_EXPORTS) {
          const declPattern = new RegExp(`\\b${symbol}\\b`);
          expect(
            declPattern.test(dctsContent),
            `dist/index.d.cts should declare "${symbol}"`,
          ).toBe(true);
        }
      }
    });

    it("contains zero accidental Node-only static imports in dist/index.js for clean browser bundling", () => {
      const esmSource = readFileSync(distEsmPath, "utf8");
      const forbiddenNodeModules = ["node:fs", "node:child_process", "node:net"];

      for (const modName of forbiddenNodeModules) {
        expect(esmSource, `dist/index.js must not reference "${modName}"`).not.toContain(modName);
      }

      const bareStaticImportPattern =
        /\b(?:import|export)\s+[^'"]*?\bfrom\s*["'](?:node:)?(?:fs|child_process|net)["']|\bimport\s*["'](?:node:)?(?:fs|child_process|net)["']|\brequire\s*\(\s*["'](?:node:)?(?:fs|child_process|net)["']\s*\)/;
      expect(
        bareStaticImportPattern.test(esmSource),
        "dist/index.js must not statically import fs, child_process, or net",
      ).toBe(false);
    });
  });
});
