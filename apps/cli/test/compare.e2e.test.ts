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

import { executionComparisonSchema, type ExecutionComparison } from "@codecitadel/contracts";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliEntry = path.join(repoRoot, "apps", "cli", "dist", "index.js");
const fixtureRoot = path.join(repoRoot, "fixtures", "execution");
const vitestEntry = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");

const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-compare-"));

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

function workTree(name: string): string {
  const target = path.join(scratch, name);
  cpSync(fixtureRoot, target, { recursive: true });
  return target;
}

/** Runs the changed tests and stores the report as JSON evidence for compare. */
async function runReport(
  tree: string,
  base: string,
  name: string,
): Promise<CliResult & { file: string }> {
  const file = path.join(scratch, `${name}-run.json`);
  const result = await cli([
    "run",
    tree,
    "--base",
    base,
    "--runner",
    vitestEntry,
    "--scanner",
    scannerPath(),
    "--format",
    "json",
    "--out",
    file,
  ]);
  return { ...result, file };
}

async function snapshotOf(tree: string, name: string): Promise<string> {
  const file = path.join(scratch, `${name}-snapshot.json`);
  const result = await cli([
    "scan",
    tree,
    "--scanner",
    scannerPath(),
    "--fail-on",
    "none",
    "--save-snapshot",
    file,
  ]);
  expect(result.code).toBe(0);
  return file;
}

const PASSING_MATH = "export function add(left: number, right: number): number {\n  return left + right;\n}\n";
const BROKEN_MATH = "export function add(left: number, right: number): number {\n  return left - right;\n}\n";

function writeMath(tree: string, body: string): void {
  writeFileSync(path.join(tree, "src", "math.ts"), body, "utf8");
}

async function compare(before: string, after: string): Promise<CliResult> {
  return cli(["compare", "--before", before, "--after", after]);
}

async function compareJson(
  before: string,
  after: string,
): Promise<CliResult & { comparison: ExecutionComparison }> {
  const result = await cli(["compare", "--before", before, "--after", after, "--format", "json"]);
  const comparison = result.stdout.startsWith("{")
    ? executionComparisonSchema.parse(JSON.parse(result.stdout))
    : null;
  expect(comparison).not.toBeNull();
  return { ...result, comparison: comparison as ExecutionComparison };
}

describe("codecitadel compare", () => {
  it("calls a test that fails after passing newly failing and exits 1", async () => {
    const tree = workTree("regression");
    const base = await snapshotOf(tree, "regression");
    writeMath(tree, `${PASSING_MATH}// touched\n`);

    const before = await runReport(tree, base, "regression");
    expect(before.code).toBe(0);

    writeMath(tree, BROKEN_MATH);
    const after = await runReport(tree, base, "regression-broken");
    expect(after.code).toBe(1);

    const textResult = await compare(before.file, after.file);
    expect(textResult.code).toBe(1);
    expect(textResult.stdout).toContain("compare → comparable");
    expect(textResult.stdout).toContain("NEWLY FAILING");
    expect(textResult.stdout).toContain("add adds two numbers");
    expect(textResult.stdout).toContain("expected");

    const jsonResult = await compareJson(before.file, after.file);
    expect(jsonResult.code).toBe(1);
    expect(jsonResult.comparison.counts.newlyFailing).toBe(1);
    expect(jsonResult.comparison.comparable).toBe(true);
  }, 120_000);

  it("calls a test that passes after failing fixed and exits 0", async () => {
    const tree = workTree("repair");
    const base = await snapshotOf(tree, "repair");
    writeMath(tree, BROKEN_MATH);
    // Both runs must see the same change classification, so the same set of
    // files is modified relative to the base in both; writes.ts is the shared
    // touch. The math repair is the tested delta between the runs.
    const touchWrites = (): void => {
      const current = readFileSync(path.join(tree, "src", "writes.ts"), "utf8");
      writeFileSync(path.join(tree, "src", "writes.ts"), `${current}// touched\n`, "utf8");
    };
    touchWrites();

    const before = await runReport(tree, base, "repair-broken");
    expect(before.code).toBe(1);

    writeMath(tree, `${PASSING_MATH}// repaired\n`);
    touchWrites();
    const after = await runReport(tree, base, "repair");
    expect(after.code).toBe(0);

    const result = await compare(before.file, after.file);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("FIXED");
    expect(result.stdout).not.toContain("NEWLY FAILING");
    // The repair itself is a change against the shared base; the test file was
    // not changed, so the fingerprint's identity is not in doubt.
    expect(result.stdout).not.toContain("[identity suspect]");
  }, 120_000);

  it("calls two identical runs of the same change still passing and exits 0", async () => {
    const tree = workTree("unchanged");
    const base = await snapshotOf(tree, "unchanged");
    writeMath(tree, `${PASSING_MATH}// touched\n`);

    const first = await runReport(tree, base, "unchanged-a");
    const second = await runReport(tree, base, "unchanged-b");
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);

    const result = await compare(first.file, second.file);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no outcome changed between the two reports.");
    expect(result.stdout).toContain("1 still passing");
  }, 120_000);

  it("refuses to certify a pair whose runner versions differ", async () => {
    const tree = workTree("version");
    const base = await snapshotOf(tree, "version");
    writeMath(tree, `${PASSING_MATH}// touched\n`);

    const first = await runReport(tree, base, "version-a");
    const second = await runReport(tree, base, "version-b");
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);

    const edited = path.join(scratch, "version-b-other-runner.json");
    const report = JSON.parse(readFileSync(second.file, "utf8")) as { record: { runnerVersion: string } };
    report.record.runnerVersion = "9.9.9";
    writeFileSync(edited, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    const result = await compare(first.file, edited);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("NOT COMPARABLE");
    expect(result.stdout).toContain("different runner versions");
    // The pairing is still shown, under the verdict instead of instead of it.
    expect(result.stdout).toContain("still passing");
  }, 120_000);

  it("refuses a pair whose selected test files differ", async () => {
    const tree = workTree("selection");
    const base = await snapshotOf(tree, "selection");
    writeMath(tree, `${PASSING_MATH}// touched\n`);

    const first = await runReport(tree, base, "selection-a");
    const second = await runReport(tree, base, "selection-b");
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);

    const edited = path.join(scratch, "selection-b-other-selection.json");
    const report = JSON.parse(readFileSync(second.file, "utf8")) as {
      impact: { tests: { selected: Array<{ path: string; depth: number; chain: Array<{ path: string; relation: string }> }> } };
    };
    report.impact.tests.selected = [
      { path: "src/other.test.ts", depth: 1, chain: [{ path: "src/other.test.ts", relation: "changed" }] },
    ];
    writeFileSync(edited, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    const result = await compare(first.file, edited);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("selected different test files");
  }, 120_000);

  it("rejects an input that is not a run report", async () => {
    const tree = workTree("wrongfile");
    const base = await snapshotOf(tree, "wrongfile");
    writeMath(tree, `${PASSING_MATH}// touched\n`);
    expect((await runReport(tree, base, "wrongfile")).code).toBe(0);

    const result = await compare(base, base);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("does not match schema version 1");
    expect(result.stderr).toContain("codecitadel run --out");
  }, 60_000);
});
