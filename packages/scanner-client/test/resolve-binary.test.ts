import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ScannerBinaryIntegrityError,
  ScannerBinaryNotFoundError,
  platformPackageName,
  resolveScannerBinary,
} from "../src/resolve-binary.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const executable = process.platform === "win32" ? "codecitadel-scanner.exe" : "codecitadel-scanner";

function tempExecutable(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pp-resolve-"));
  const file = path.join(dir, name);
  writeFileSync(file, "not a real binary");
  return file;
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Builds the layout npm produces: the platform package sits in a consumer's
 * `node_modules`, next to the package that depends on it.
 */
function platformTree(): { startDir: string; packageDir: string } {
  const startDir = mkdtempSync(path.join(tmpdir(), "pp-platform-"));
  const packageDir = path.join(startDir, "node_modules", ...platformPackageName().split("/"));
  mkdirSync(path.join(packageDir, "bin"), { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: platformPackageName(), version: "0.1.0" }),
  );
  return { startDir, packageDir };
}

function writeBinary(packageDir: string, contents: string): string {
  const file = path.join(packageDir, "bin", executable);
  writeFileSync(file, contents);
  return file;
}

function writeManifest(packageDir: string, manifest: unknown): void {
  writeFileSync(path.join(packageDir, "binary.json"), JSON.stringify(manifest));
}

describe("platformPackageName", () => {
  it("names one package per platform and architecture", () => {
    expect(platformPackageName("win32", "x64")).toBe("@codecitadel/scanner-win32-x64");
    expect(platformPackageName("darwin", "arm64")).toBe("@codecitadel/scanner-darwin-arm64");
  });
});

describe("resolveScannerBinary", () => {
  it("prefers an explicit path", () => {
    const file = tempExecutable("scanner-explicit");
    const resolved = resolveScannerBinary({ explicitPath: file, env: {} });
    expect(resolved.source).toBe("explicit");
    expect(resolved.path).toBe(path.resolve(file));
  });

  it("uses CODECITADEL_SCANNER_BIN when no explicit path is given", () => {
    const file = tempExecutable("scanner-env");
    const resolved = resolveScannerBinary({ env: { CODECITADEL_SCANNER_BIN: file }, startDir: repoRoot });
    expect(resolved.source).toBe("environment");
  });

  it("resolves a verified binary from the platform package", () => {
    const { startDir, packageDir } = platformTree();
    const binary = writeBinary(packageDir, "pretend scanner");
    writeManifest(packageDir, { file: `bin/${executable}`, sha256: sha256(binary) });

    const resolved = resolveScannerBinary({ env: {}, startDir });
    expect(resolved.source).toBe("platform-package");
    expect(resolved.path).toBe(binary);
  });

  it("finds a local Cargo build by searching upward", () => {
    const resolved = resolveScannerBinary({ env: {}, startDir: path.join(repoRoot, "packages") });
    expect(resolved.source).toBe("workspace-build");
    expect(resolved.path).toMatch(/target[\\/](release|debug)[\\/]codecitadel-scanner(\.exe)?$/);
  });

  it("refuses a binary whose digest does not match the manifest", () => {
    const { startDir, packageDir } = platformTree();
    writeBinary(packageDir, "pretend scanner");
    writeManifest(packageDir, { file: `bin/${executable}`, sha256: "0".repeat(64) });

    expect(() => resolveScannerBinary({ env: {}, startDir })).toThrow(ScannerBinaryIntegrityError);
    expect(() => resolveScannerBinary({ env: {}, startDir })).toThrow(/sha256 mismatch/);
  });

  it("refuses a binary that was replaced after packaging", () => {
    const { startDir, packageDir } = platformTree();
    const binary = writeBinary(packageDir, "genuine scanner");
    writeManifest(packageDir, { file: `bin/${executable}`, sha256: sha256(binary) });
    writeFileSync(binary, "swapped scanner");

    expect(() => resolveScannerBinary({ env: {}, startDir })).toThrow(/sha256 mismatch/);
  });

  it("refuses a binary with no manifest to check it against", () => {
    const { startDir, packageDir } = platformTree();
    writeBinary(packageDir, "pretend scanner");

    expect(() => resolveScannerBinary({ env: {}, startDir })).toThrow(/binary\.json is missing/);
  });

  it("refuses a manifest that points outside its own package", () => {
    const { startDir, packageDir } = platformTree();
    writeBinary(packageDir, "pretend scanner");
    writeManifest(packageDir, { file: "../../outside", sha256: "0".repeat(64) });

    expect(() => resolveScannerBinary({ env: {}, startDir })).toThrow(/outside its own package/);
  });

  it("treats an unbuilt platform package as absent and explains every path it tried", () => {
    const { startDir, packageDir } = platformTree();
    expect(packageDir).toContain("scanner-");

    const error = (() => {
      try {
        resolveScannerBinary({ env: {}, startDir });
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(ScannerBinaryNotFoundError);
    const notFound = error as ScannerBinaryNotFoundError;
    expect(notFound.message).toContain(platformPackageName());
    expect(notFound.message).toContain("CODECITADEL_SCANNER_BIN");
    expect(notFound.tried.length).toBeGreaterThan(0);
  });

  it("explains every path it tried when nothing resolves", () => {
    const error = (() => {
      try {
        resolveScannerBinary({
          env: { CODECITADEL_SCANNER_BIN: path.join(repoRoot, "no-such-binary") },
        });
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(ScannerBinaryNotFoundError);
    expect((error as ScannerBinaryNotFoundError).message).toContain("CODECITADEL_SCANNER_BIN");
  });
});
