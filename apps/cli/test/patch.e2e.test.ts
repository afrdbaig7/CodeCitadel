import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { patchVerificationReportSchema, type PatchVerificationReport } from "@codecitadel/contracts";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliEntry = path.join(repoRoot, "apps", "cli", "dist", "index.js");
const fixtureRoot = path.join(repoRoot, "fixtures", "execution");
const vitestEntry = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");

const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-patch-e2e-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function scannerPath(): string {
  const name = process.platform === "win32" ? "codecitadel-scanner.exe" : "codecitadel-scanner";
  for (const profile of ["release", "debug"]) {
    const candidate = path.join(repoRoot, "target", profile, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "The scanner binary is missing. Build it before running these tests: cargo build --release --package scanner-cli",
  );
}

async function cli(args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntry, ...args], {
      cwd: repoRoot,
      timeout: 180_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 2,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

let counter = 0;
function workTree(name: string): string {
  counter += 1;
  const target = path.join(scratch, `${name}-${counter}`);
  cpSync(fixtureRoot, target, { recursive: true });
  return target;
}

function writeScratch(name: string, content: string): string {
  counter += 1;
  const file = path.join(scratch, `${name}-${counter}`);
  writeFileSync(file, content, "utf8");
  return file;
}

/**
 * Produces the stored run whose selection `patch verify` re-executes: snapshot
 * the fixture, touch the module so its test is selected, and run it.
 */
async function beforeReport(tree: string, name: string): Promise<string> {
  const snapshot = path.join(scratch, `${name}-snapshot.json`);
  const scanned = await cli([
    "scan",
    tree,
    "--scanner",
    scannerPath(),
    "--fail-on",
    "none",
    "--save-snapshot",
    snapshot,
  ]);
  expect(scanned.code).toBe(0);

  const mathFile = path.join(tree, "src", "math.ts");
  writeFileSync(mathFile, `${readFileSync(mathFile, "utf8")}\n// touched\n`, "utf8");

  const report = path.join(scratch, `${name}-before.json`);
  const run = await cli([
    "run",
    tree,
    "--base",
    snapshot,
    "--runner",
    vitestEntry,
    "--scanner",
    scannerPath(),
    "--format",
    "json",
    "--out",
    report,
    "--timeout-ms",
    "60000",
  ]);
  expect(run.code).toBe(0);
  expect(run.stderr).toContain("passed:");
  return report;
}

const HARMLESS_PATCH = [
  "--- a/src/math.ts",
  "+++ b/src/math.ts",
  "@@ -1,3 +1,4 @@",
  " export function add(left: number, right: number): number {",
  "+  // add, not subtract",
  "   return left + right;",
  " }",
  "",
].join("\n");

const BREAKING_PATCH = [
  "--- a/src/math.ts",
  "+++ b/src/math.ts",
  "@@ -1,3 +1,3 @@",
  " export function add(left: number, right: number): number {",
  "-  return left + right;",
  "+  return left - right;",
  " }",
  "",
].join("\n");

const SKIP_PATCH = [
  "--- a/src/math.test.ts",
  "+++ b/src/math.test.ts",
  "@@ -7,3 +7,6 @@",
  "     expect(add(2, 3)).toBe(5);",
  "   });",
  '+  it.skip("adds negative numbers", () => {',
  "+    expect(add(-1, -1)).toBe(-2);",
  "+  });",
  " });",
  "",
].join("\n");

const STALE_PATCH = [
  "--- a/src/math.ts",
  "+++ b/src/math.ts",
  "@@ -1,3 +1,3 @@",
  " export function subtract(left: number, right: number): number {",
  "-  return left - right;",
  "+  return left + right;",
  " }",
  "",
].join("\n");

function parseReport(file: string): PatchVerificationReport {
  return patchVerificationReportSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

describe("codecitadel patch verify", () => {
  it("verifies a patch whose checks still pass, and leaves the checkout untouched", { timeout: 120_000 }, async () => {
    const tree = workTree("verified");
    const before = await beforeReport(tree, "verified");
    const patch = writeScratch("harmless.patch", HARMLESS_PATCH);
    const out = path.join(scratch, "verified-report.json");

    const result = await cli([
      "patch",
      "verify",
      patch,
      "--before",
      before,
      "--runner",
      vitestEntry,
      "--format",
      "json",
      "--out",
      out,
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("verified:");

    const report = parseReport(out);
    expect(report.verdict).toBe("verified");
    expect(report.patch.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.patch).toMatchObject({ files: 1, addedLines: 1, removedLines: 0 });
    expect(report.inspection.files).toEqual([
      {
        path: "src/math.ts",
        status: "modified",
        kind: "source",
        addedLines: 1,
        removedLines: 0,
      },
    ]);
    expect(report.inspection.signals).toEqual([]);
    expect(report.comparison?.comparable).toBe(true);
    expect(report.comparison?.counts).toMatchObject({ stillPassing: 1, newlyFailing: 0 });
    expect(report.requirements).toBeNull();
    expect(report.requirementRegressions).toEqual([]);
    expect(report.limitations.join(" ")).toContain("codecitadel.requirements.json");
    expect(report.limitations.join(" ")).toContain("checkout was never modified");

    // The patch was applied only to the disposable copy.
    expect(readFileSync(path.join(tree, "src", "math.ts"), "utf8")).not.toContain(
      "add, not subtract",
    );
  });

  it("reports a behavioural break as not verified and exits 1", { timeout: 120_000 }, async () => {
    const tree = workTree("breaking");
    const before = await beforeReport(tree, "breaking");
    const patch = writeScratch("breaking.patch", BREAKING_PATCH);

    const result = await cli([
      "patch",
      "verify",
      patch,
      "--before",
      before,
      "--runner",
      vitestEntry,
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("NOT VERIFIED");
    expect(result.stdout).toContain("newly failing");
    expect(result.stdout).toContain("src/math.test.ts › add adds two numbers");
    expect(result.stderr).toContain("test(s) that passed before the patch fail after it");
  });

  it("refuses to verify a patch that skips a test", { timeout: 120_000 }, async () => {
    const tree = workTree("weakening");
    const before = await beforeReport(tree, "weakening");
    const patch = writeScratch("skip.patch", SKIP_PATCH);
    const out = path.join(scratch, "weakening-report.json");

    const result = await cli([
      "patch",
      "verify",
      patch,
      "--before",
      before,
      "--runner",
      vitestEntry,
      "--format",
      "json",
      "--out",
      out,
    ]);

    expect(result.code).toBe(1);
    const report = parseReport(out);
    expect(report.verdict).toBe("not_verified");
    expect(report.inspection.weakening).toBe(1);
    expect(report.inspection.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "added-skip", severity: "weakening", file: "src/math.test.ts" }),
        expect.objectContaining({ kind: "edited-test", severity: "warning" }),
      ]),
    );
    expect(report.reason).toContain("weakening signal");
  });

  it("refuses to run when a named environment variable is not set", { timeout: 120_000 }, async () => {
    const tree = workTree("env-unset");
    const before = await beforeReport(tree, "env-unset");
    const patch = writeScratch("harmless-env.patch", HARMLESS_PATCH);

    const result = await cli([
      "patch",
      "verify",
      patch,
      "--before",
      before,
      "--runner",
      vitestEntry,
      "--env",
      "CODECITADEL_TEST_UNSET_FOR_PATCH_E2E",
    ]);

    // Refused before the patch is applied or anything executes: a check that
    // cannot reach its resource must not produce a result.
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("CODECITADEL_TEST_UNSET_FOR_PATCH_E2E");
    expect(result.stderr).toContain("not set in this process");
  });

  it("refuses a stale patch before executing anything and exits 2", { timeout: 120_000 }, async () => {
    const tree = workTree("stale");
    const before = await beforeReport(tree, "stale");
    const patch = writeScratch("stale.patch", STALE_PATCH);
    const out = path.join(scratch, "stale-report.json");

    const result = await cli([
      "patch",
      "verify",
      patch,
      "--before",
      before,
      "--runner",
      vitestEntry,
      "--format",
      "json",
      "--out",
      out,
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("did not apply");

    const report = parseReport(out);
    expect(report.verdict).toBe("not_applied");
    expect(report.comparison).toBeNull();
    expect(report.after).toBeNull();
    expect(report.reason).toContain("stale");
  });

  it("rejects a patch that escapes the root or is not a unified diff", { timeout: 120_000 }, async () => {
    const tree = workTree("invalid");
    const before = await beforeReport(tree, "invalid");

    const traversal = writeScratch(
      "traversal.patch",
      ["--- a/../outside.ts", "+++ b/../outside.ts", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"),
    );
    const escaped = await cli(["patch", "verify", traversal, "--before", before]);
    expect(escaped.code).toBe(2);
    expect(escaped.stderr).toContain("must stay inside the analyzed root");

    const prose = writeScratch("prose.patch", "this is not a diff\n");
    const invalid = await cli(["patch", "verify", prose, "--before", before]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain('Expected a "--- " file header');
  });
});
