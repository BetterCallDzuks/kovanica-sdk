import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const packageJsonPath = resolve(pkgRoot, "package.json");
const packageLockPath = resolve(pkgRoot, "package-lock.json");
const changelogPath = resolve(pkgRoot, "CHANGELOG.md");
const readmePath = resolve(pkgRoot, "README.md");
const distDir = resolve(pkgRoot, "dist");

interface PackageJsonExportsEntry {
  import?: {
    types?: string;
    default?: string;
  };
  require?: {
    types?: string;
    default?: string;
  };
}

interface PackageJson {
  name: string;
  version: string;
  type?: string;
  main?: string;
  module?: string;
  types?: string;
  sideEffects?: boolean;
  exports?: Record<string, PackageJsonExportsEntry>;
  files?: string[];
}

interface PackageLockJson {
  name?: string;
  version?: string;
  packages?: Record<string, { name?: string; version?: string }>;
}

const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
const pkgLock = JSON.parse(readFileSync(packageLockPath, "utf8")) as PackageLockJson;
const changelog = readFileSync(changelogPath, "utf8");
const readme = readFileSync(readmePath, "utf8");
const hasDistDir = existsSync(distDir);

describe("kovanica-sdk v0.7.0 release readiness", () => {
  it("maintains package.json and package-lock.json versions at or above 0.7.0", () => {
    expect(pkg.name).toBe("kovanica-sdk");
    const [major, minor] = pkg.version.split(".").map(Number);
    expect(major > 0 || (major === 0 && minor >= 7)).toBe(true);
    expect(pkgLock.name).toBe("kovanica-sdk");
    expect(pkgLock.version).toBe(pkg.version);
    expect(pkgLock.packages?.[""]?.version).toBe(pkg.version);
  });

  it("documents v0.7.0 additions in CHANGELOG.md", () => {
    const startIdx = changelog.search(/^## \[0\.7\.0\]/m);
    expect(startIdx, "CHANGELOG.md must contain a ## [0.7.0] section").toBeGreaterThanOrEqual(0);

    const rest = changelog.slice(startIdx);
    const nextSectionOffset = rest.slice(1).search(/^## \[/m);
    const section = nextSectionOffset >= 0 ? rest.slice(0, nextSectionOffset + 1) : rest;

    const requiredSymbols = [
      "estimatePriorityFeeTiers",
      "computeRbfFeeBump",
      "checkMultisigQuorum",
      "encodeMultisigProposalBundle",
      "decodeMultisigProposalBundle",
      "queryContractLogsPaginated",
    ];

    for (const symbol of requiredSymbols) {
      expect(section, `CHANGELOG.md [0.7.0] section should document "${symbol}"`).toContain(symbol);
    }
  });

  it("references v0.7.0 highlights in README.md", () => {
    expect(readme).toContain("v0.7.0");
    expect(readme).toContain("estimatePriorityFeeTiers");
    expect(readme).toContain("computeRbfFeeBump");
    expect(readme).toContain("checkMultisigQuorum");
    expect(readme).toContain("encodeMultisigProposalBundle");
    expect(readme).toContain("decodeMultisigProposalBundle");
    expect(readme).toContain("queryContractLogsPaginated");
  });

  it("has consistent package.json exports, main, module, types, sideEffects, and files fields", () => {
    expect(pkg.type).toBe("module");
    expect(pkg.sideEffects).toBe(false);

    expect(pkg.main).toBe("./dist/index.cjs");
    expect(pkg.module).toBe("./dist/index.js");
    expect(pkg.types).toBe("./dist/index.d.ts");

    const rootExport = pkg.exports?.["."];
    expect(rootExport, 'package.json exports["."] must be defined').toBeDefined();
    expect(rootExport?.import?.default).toBe(pkg.module);
    expect(rootExport?.import?.types).toBe(pkg.types);
    expect(rootExport?.require?.default).toBe(pkg.main);
    expect(rootExport?.require?.types).toBe("./dist/index.d.cts");

    const distTargets = [
      pkg.main,
      pkg.module,
      pkg.types,
      rootExport?.import?.default,
      rootExport?.import?.types,
      rootExport?.require?.default,
      rootExport?.require?.types,
    ].filter((entry): entry is string => typeof entry === "string");

    for (const relPath of distTargets) {
      expect(relPath.startsWith("./dist/"), `entrypoint "${relPath}" must live under ./dist/`).toBe(
        true,
      );
    }

    expect(Array.isArray(pkg.files)).toBe(true);
    for (const requiredFile of ["dist", "README.md", "CHANGELOG.md", "LICENSE"]) {
      expect(pkg.files, `package.json files should include "${requiredFile}"`).toContain(
        requiredFile,
      );
    }
  });

  it.runIf(hasDistDir)("points package.json entrypoints to existing built dist/ artifacts", () => {
    const distTargets = [
      pkg.main,
      pkg.module,
      pkg.types,
      pkg.exports?.["."]?.import?.default,
      pkg.exports?.["."]?.import?.types,
      pkg.exports?.["."]?.require?.default,
      pkg.exports?.["."]?.require?.types,
    ].filter((entry): entry is string => typeof entry === "string");

    const uniqueTargets = [...new Set(distTargets)];
    expect(uniqueTargets.length).toBeGreaterThanOrEqual(4);

    for (const relPath of uniqueTargets) {
      const absPath = resolve(pkgRoot, relPath);
      expect(existsSync(absPath), `built artifact "${relPath}" must exist after build`).toBe(true);
    }
  });
});
