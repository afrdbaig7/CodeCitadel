import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { testRunReportSchema, type TestRunReport } from "@codecitadel/contracts";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliEntry = path.join(repoRoot, "apps", "cli", "dist", "index.js");
const fixtureRoot = path.join(repoRoot, "fixtures", "execution");
const vitestEntry = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");

const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-run-"));

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

async function cli(
  args: readonly string[],
  extraEnv: Record<string, string> = {},
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntry, ...args], {
      cwd: repoRoot,
      timeout: 180_000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, ...extraEnv },
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

function touch(tree: string, relativePath: string, suffix: string): void {
  const file = path.join(tree, relativePath);
  writeFileSync(file, `${readFileSync(file, "utf8")}${suffix}`, "utf8");
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

async function run(
  tree: string,
  base: string,
  extra: readonly string[] = [],
  extraEnv: Record<string, string> = {},
): Promise<CliResult> {
  return cli(
    [
      "run",
      tree,
      "--base",
      base,
      "--runner",
      vitestEntry,
      "--scanner",
      scannerPath(),
      "--timeout-ms",
      "60000",
      ...extra,
    ],
    extraEnv,
  );
}

function parseReport(stdout: string): TestRunReport {
  return testRunReportSchema.parse(JSON.parse(stdout));
}

describe("codecitadel run", () => {
  it("executes only the selected test and records a pass", { timeout: 120_000 }, async () => {
    const tree = workTree("passing");
    const base = await snapshotOf(tree, "passing");

    touch(tree, path.join("src", "math.ts"), "\n// touched\n");

    const result = await run(tree, base, ["--format", "json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("passed:");

    const report = parseReport(result.stdout);
    expect(report.impact.tests.selected.map((entry) => entry.path)).toEqual(["src/math.test.ts"]);
    expect(report.record.status).toBe("passed");
    expect(report.record.exitCode).toBe(0);
    expect(report.record.runner).toBe("vitest");
    expect(report.record.runnerVersion).not.toBeNull();
    expect(report.record.isolation.mode).toBe("source-copy");
    expect(report.record.isolation.sharedPaths).toContain("node_modules");
    expect(report.record.counts).toMatchObject({ passed: 1, failed: 0, total: 1 });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      file: "src/math.test.ts",
      name: "add adds two numbers",
      status: "passed",
      message: null,
    });
    expect(report.limitations.join(" ")).toContain("not proof that the change is correct");
    expect(existsSync(path.join(tree, "isolation-marker.txt"))).toBe(false);
  });

  it("reports a failing test as failed and exits 1", { timeout: 120_000 }, async () => {
    const tree = workTree("failing");
    const base = await snapshotOf(tree, "failing");

    writeFileSync(
      path.join(tree, "src", "math.ts"),
      "export function add(left: number, right: number): number {\n  return left - right;\n}\n",
      "utf8",
    );

    const result = await run(tree, base, ["--format", "json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("failed:");

    const report = parseReport(result.stdout);
    expect(report.record.status).toBe("failed");
    expect(report.record.counts).toMatchObject({ passed: 0, failed: 1, total: 1 });
    expect(report.results[0]?.status).toBe("failed");
    expect(report.results[0]?.message).toContain("expected");
  });

  it("runs in a disposable copy, so a test writing to its working directory leaves the checkout alone", { timeout: 120_000 }, async () => {
    const tree = workTree("isolation");
    const base = await snapshotOf(tree, "isolation");

    touch(tree, path.join("src", "writes.ts"), "\n// touched\n");

    const result = await run(tree, base);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("PASSED");
    expect(result.stdout).toContain("src/writes.test.ts");
    expect(result.stdout).toContain("isolation source-copy");
    expect(result.stdout).toContain("limitations");

    // The test itself asserts the write succeeded in its working directory.
    // The checkout is untouched, so that directory was the copy.
    expect(existsSync(path.join(tree, "isolation-marker.txt"))).toBe(false);
  });

  it("records a named environment variable it forwarded, and refuses names it cannot", { timeout: 120_000 }, async () => {
    const tree = workTree("env-forwarding");
    const base = await snapshotOf(tree, "env-forwarding");

    touch(tree, path.join("src", "math.ts"), "\n// touched\n");

    const forwarded = await run(
      tree,
      base,
      ["--format", "json", "--env", "CODECITADEL_TEST_FORWARD_ME"],
      { CODECITADEL_TEST_FORWARD_ME: "demo-value" },
    );
    expect(forwarded.code).toBe(0);
    const report = parseReport(forwarded.stdout);
    expect(report.record.status).toBe("passed");
    // The name is recorded; the value is not.
    expect(report.limitations.join("\n")).toContain(
      "Forwarded environment variables by name: CODECITADEL_TEST_FORWARD_ME",
    );
    expect(forwarded.stdout).not.toContain("demo-value");

    const invalid = await run(tree, base, ["--env", "not-a-name"]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("not an environment variable name");

    const unset = await run(tree, base, ["--env", "CODECITADEL_TEST_UNSET_FOR_E2E"]);
    expect(unset.code).toBe(2);
    expect(unset.stderr).toContain("not set in this process");
  });

  it("executes nothing and reports skipped when no test can see the change", async () => {
    const tree = workTree("nothing-selected");
    const base = await snapshotOf(tree, "nothing-selected");

    touch(tree, "README.md", "\n<!-- touched -->\n");

    const result = await run(tree, base, ["--format", "json"]);
    expect(result.code).toBe(0);

    const report = parseReport(result.stdout);
    expect(report.impact.tests.selected).toHaveLength(0);
    expect(report.record.status).toBe("skipped");
    expect(report.record.command).toEqual([]);
    expect(report.record.exitCode).toBeNull();
    expect(report.results).toEqual([]);
    expect(report.record.detail).toContain("nothing was executed");
    expect(report.limitations.join(" ")).toContain("not evidence that the change is safe");
  });

  it("runs in the checkout only when asked explicitly, and records that mode", { timeout: 120_000 }, async () => {
    const tree = workTree("in-place");
    // The checkout needs its own dependency resolution for the runner to load
    // the test files; a real project would have one here.
    symlinkSync(
      path.join(repoRoot, "node_modules"),
      path.join(tree, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const base = await snapshotOf(tree, "in-place");

    touch(tree, path.join("src", "writes.ts"), "\n// touched\n");

    const result = await run(tree, base, ["--format", "json", "--isolation", "none"]);
    expect(result.code).toBe(0);

    const report = parseReport(result.stdout);
    expect(report.record.status).toBe("passed");
    expect(report.record.isolation.mode).toBe("none");
    expect(report.record.isolation.sharedPaths).toEqual([]);
    expect(report.results[0]?.status).toBe("passed");
    expect(report.record.isolation.limitations.join(" ")).toContain(
      "can modify the working tree",
    );
    // This is exactly what `none` admits: the test wrote into the checkout.
    expect(existsSync(path.join(tree, "isolation-marker.txt"))).toBe(true);
  });

  it("kills a run at the deadline and reports it as timed out, not failed", async () => {
    const tree = workTree("timeout");
    const base = await snapshotOf(tree, "timeout");

    touch(tree, path.join("src", "math.ts"), "\n// touched\n");

    const result = await run(tree, base, ["--format", "json", "--timeout-ms", "1"]);
    expect(result.code).toBe(2);

    const report = parseReport(result.stdout);
    expect(report.record.status).toBe("timed_out");
    expect(report.record.counts.total).toBe(0);
    expect(report.results).toEqual([]);
    expect(report.record.detail).toContain("killed after 1 ms");
  });

  it("fails with an actionable message when the named runner does not exist", async () => {
    const tree = workTree("missing-runner");
    const base = await snapshotOf(tree, "missing-runner");

    touch(tree, path.join("src", "math.ts"), "\n// touched\n");

    const result = await cli([
      "run",
      tree,
      "--base",
      base,
      "--runner",
      path.join(scratch, "absent", "vitest.mjs"),
      "--scanner",
      scannerPath(),
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Cannot find the Vitest entry point");
  });
});
