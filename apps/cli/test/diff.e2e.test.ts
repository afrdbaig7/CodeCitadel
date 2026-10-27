import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { snapshotDiffSchema, snapshotSchema, type SnapshotDiff } from "@codecitadel/contracts";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliEntry = path.join(repoRoot, "apps", "cli", "dist", "index.js");
const fixtureRoot = path.join(repoRoot, "fixtures", "security");

const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-diff-"));

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

/** A private copy of the faulty fixture so one test cannot affect another. */
function workTree(name: string): string {
  const target = path.join(scratch, name);
  cpSync(fixtureRoot, target, { recursive: true });
  return target;
}

async function saveSnapshot(tree: string, file: string): Promise<void> {
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
  expect(result.stderr).toContain("snapshot written");
}

function parseDiff(stdout: string): SnapshotDiff {
  return snapshotDiffSchema.parse(JSON.parse(stdout));
}

describe("codecitadel scan --save-snapshot", () => {
  it("writes a schema-valid snapshot and refuses to overwrite it", async () => {
    const tree = workTree("immutable");
    const snapshotFile = path.join(scratch, "immutable-snapshot.json");
    await saveSnapshot(tree, snapshotFile);

    const snapshot = snapshotSchema.parse(JSON.parse(readFileSync(snapshotFile, "utf8")));
    expect(snapshot.root).toContain("immutable");
    expect(snapshot.files.length).toBeGreaterThan(0);
    expect(snapshot.files.every((entry) => entry.digest?.startsWith("sha256:"))).toBe(true);

    const second = await cli([
      "scan",
      tree,
      "--scanner",
      scannerPath(),
      "--save-snapshot",
      snapshotFile,
    ]);
    expect(second.code).toBe(2);
    expect(second.stderr).toContain("Refusing to overwrite");
    // The original evidence must be untouched by the rejected write.
    expect(snapshotSchema.parse(JSON.parse(readFileSync(snapshotFile, "utf8")))).toEqual(snapshot);
  });
});

describe("codecitadel diff", () => {
  it("reports an unchanged tree as unchanged, with no introduced findings", async () => {
    const tree = workTree("unchanged");
    const snapshotFile = path.join(scratch, "unchanged-snapshot.json");
    await saveSnapshot(tree, snapshotFile);

    const result = await cli([
      "diff",
      tree,
      "--base",
      snapshotFile,
      "--format",
      "json",
      "--scanner",
      scannerPath(),
    ]);
    expect(result.code).toBe(0);

    const diff = parseDiff(result.stdout);
    expect(diff.files.unchanged).toBeGreaterThan(0);
    expect(diff.files.added).toHaveLength(0);
    expect(diff.files.modified).toHaveLength(0);
    expect(diff.findings.introduced).toHaveLength(0);
    expect(diff.findings.resolved).toHaveLength(0);
    expect(diff.findings.carriedOver).toBeGreaterThan(0);
    expect(diff.limitations.length).toBeGreaterThan(0);
  });

  it("names introduced findings and only gates when asked to", async () => {
    const tree = workTree("introduced");
    const snapshotFile = path.join(scratch, "introduced-snapshot.json");
    await saveSnapshot(tree, snapshotFile);

    writeFileSync(
      path.join(tree, "src", "shell.js"),
      'const { exec } = require("child_process");\nexec("ls", { shell: true });\n',
      "utf8",
    );

    const reportOnly = await cli([
      "diff",
      tree,
      "--base",
      snapshotFile,
      "--format",
      "json",
      "--scanner",
      scannerPath(),
    ]);
    expect(reportOnly.code).toBe(0);
    const diff = parseDiff(reportOnly.stdout);
    expect(diff.files.added.map((entry) => entry.path)).toEqual(["src/shell.js"]);
    expect(diff.findings.introduced.map((finding) => finding.ruleId)).toContain(
      "security/shell-enabled-subprocess",
    );

    const gated = await cli([
      "diff",
      tree,
      "--base",
      snapshotFile,
      "--fail-on",
      "medium",
      "--scanner",
      scannerPath(),
    ]);
    expect(gated.code).toBe(1);
    expect(gated.stderr).toContain("introduced finding(s) at or above");
  });

  it("reports a fixed finding as resolved and never leaks the secret", async () => {
    const tree = workTree("resolved");
    const snapshotFile = path.join(scratch, "resolved-snapshot.json");
    await saveSnapshot(tree, snapshotFile);

    const tlsFile = path.join(tree, "src", "tls.ts");
    const source = readFileSync(tlsFile, "utf8");
    writeFileSync(tlsFile, source.replace(/rejectUnauthorized:\s*false/, "rejectUnauthorized: true"), "utf8");

    const result = await cli([
      "diff",
      tree,
      "--base",
      snapshotFile,
      "--format",
      "markdown",
      "--scanner",
      scannerPath(),
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("# CodeCitadel change report");
    expect(result.stdout).toContain("### Resolved");
    expect(result.stdout).toContain("security/tls-verification-disabled");
    expect(result.stdout).toContain("## Limitations");
    expect(result.stdout).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("rejects a snapshot it cannot understand instead of guessing", async () => {
    const tree = workTree("invalid-snapshot");
    const snapshotFile = path.join(scratch, "invalid-snapshot.json");
    writeFileSync(snapshotFile, '{"schemaVersion": 99}\n', "utf8");

    const result = await cli([
      "diff",
      tree,
      "--base",
      snapshotFile,
      "--scanner",
      scannerPath(),
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("does not match schema version");
  });
});
