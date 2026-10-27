import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { impactReportSchema, type ImpactReport } from "@codecitadel/contracts";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliEntry = path.join(repoRoot, "apps", "cli", "dist", "index.js");
const fixtureRoot = path.join(repoRoot, "fixtures", "impact");

const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-impact-"));

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
      timeout: 60_000,
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

function parseImpact(stdout: string): ImpactReport {
  return impactReportSchema.parse(JSON.parse(stdout));
}

async function impact(tree: string, base: string): Promise<CliResult> {
  return cli(["impact", tree, "--base", base, "--format", "json", "--scanner", scannerPath()]);
}

describe("codecitadel impact", () => {
  it("selects only the test that can see the change, and explains the chain", async () => {
    const tree = workTree("math-change");
    const base = await snapshotOf(tree, "math");

    const mathFile = path.join(tree, "src", "math.ts");
    writeFileSync(
      mathFile,
      `${readFileSync(mathFile, "utf8")}\nexport function subtract(left: number, right: number): number {\n  return left - right;\n}\n`,
      "utf8",
    );

    const result = await impact(tree, base);
    expect(result.code).toBe(0);

    const report = parseImpact(result.stdout);
    expect(report.changed).toEqual([{ path: "src/math.ts", change: "modified" }]);
    expect(report.tests.selected.map((entry) => entry.path)).toEqual(["src/math.test.ts"]);
    expect(report.tests.selected[0]?.chain).toEqual([
      { path: "src/math.test.ts", relation: "imports" },
      { path: "src/math.ts", relation: "changed" },
    ]);
    expect(report.tests.notSelected).toBe(1);
    expect(report.complete).toBe(true);
    expect(report.graph.modules).toBeGreaterThanOrEqual(5);
    // The entry module imports math, so it is impacted but is not a test.
    expect(report.impacted.map((entry) => entry.path)).toContain("src/index.ts");
  });

  it("selects the other branch when the other module changes", async () => {
    const tree = workTree("format-change");
    const base = await snapshotOf(tree, "format");

    const formatFile = path.join(tree, "src", "format.ts");
    writeFileSync(
      formatFile,
      `${readFileSync(formatFile, "utf8")}\nexport const currencies = ["USD", "EUR"];\n`,
      "utf8",
    );

    const report = parseImpact((await impact(tree, base)).stdout);
    expect(report.tests.selected.map((entry) => entry.path)).toEqual(["src/format.test.ts"]);
    expect(report.tests.notSelected).toBe(1);
  });

  it("reports an unchanged tree as selecting nothing, without claiming completeness for tests", async () => {
    const tree = workTree("unchanged");
    const base = await snapshotOf(tree, "unchanged");

    const report = parseImpact((await impact(tree, base)).stdout);
    expect(report.changed).toHaveLength(0);
    expect(report.tests.selected).toHaveLength(0);
    expect(report.tests.notSelected).toBe(2);
    expect(report.limitations.length).toBeGreaterThan(0);
  });

  it("flags a change it cannot place in the graph instead of returning a clean selection", async () => {
    const tree = workTree("non-module-change");
    const base = await snapshotOf(tree, "non-module");

    writeFileSync(path.join(tree, "README.md"), "# notes\n", "utf8");

    const report = parseImpact((await impact(tree, base)).stdout);
    expect(report.complete).toBe(false);
    expect(report.incompleteReasons.join(" ")).toContain("README.md");
    expect(report.limitations.join(" ")).toContain("lower bound");
  });

  it("renders a readable text report by default", async () => {
    const tree = workTree("text-output");
    const base = await snapshotOf(tree, "text");

    const mathFile = path.join(tree, "src", "math.ts");
    writeFileSync(mathFile, `${readFileSync(mathFile, "utf8")}\n// touched\n`, "utf8");

    const result = await cli(["impact", tree, "--base", base, "--scanner", scannerPath()]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("src/math.test.ts → src/math.ts");
    expect(result.stdout).toContain("limitations");
  });

  it("rejects an unusable base snapshot with exit code 2", async () => {
    const tree = workTree("bad-base");
    const result = await cli([
      "impact",
      tree,
      "--base",
      path.join(scratch, "does-not-exist.json"),
      "--scanner",
      scannerPath(),
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Cannot read the snapshot");
  });
});
