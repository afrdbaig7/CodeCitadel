import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  codeCitadelReportSchema,
  sarifLogSchema,
  type CodeCitadelReport,
} from "@codecitadel/contracts";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliEntry = path.join(repoRoot, "apps", "cli", "dist", "index.js");

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

/** Runs the packed CLI entry point exactly as a user would. */
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

function parseReport(stdout: string): CodeCitadelReport {
  return codeCitadelReportSchema.parse(JSON.parse(stdout));
}

describe("codecitadel scan", () => {
  it("reports a clean fixture with no findings and an explicit scope", async () => {
    const result = await cli(["scan", "fixtures/clean", "--scanner", scannerPath()]);
    expect(result.code).toBe(0);
    const report = parseReport(result.stdout);
    expect(report.findings).toHaveLength(0);
    expect(report.scope.filesScanned).toBeGreaterThanOrEqual(2);
    expect(report.scope.truncated).toBe(false);
    expect(report.scope.limitations.length).toBeGreaterThan(0);
  });

  it("finds the faulty fixture's problems and fails the default policy", async () => {
    const result = await cli(["scan", "fixtures/security", "--scanner", scannerPath()]);
    expect(result.code).toBe(1);
    const report = parseReport(result.stdout);

    expect(report.findings.map((finding) => finding.ruleId).sort()).toEqual([
      "quality/committed-todo-marker",
      "secrets/aws-access-key-id",
      "security/dangerous-html-sink",
      "security/shell-enabled-subprocess",
      "security/tls-verification-disabled",
    ]);
    expect(report.summary.bySeverity).toEqual({
      critical: 0,
      high: 2,
      medium: 2,
      low: 0,
      info: 1,
    });
    expect(report.findings.every((finding) => finding.evidenceStatus === "suspected")).toBe(true);
  });

  it("honours ignore rules and never leaks the matched secret", async () => {
    const result = await cli(["scan", "fixtures/security", "--scanner", scannerPath()]);
    // node_modules/example/index.js is ignored and must not be analysed.
    expect(result.stdout).not.toContain("node_modules");
    expect(result.stdout).not.toContain("AKIAIOSFODNN7EXAMPLE");
    const report = parseReport(result.stdout);
    const secret = report.findings.find((finding) => finding.ruleId === "secrets/aws-access-key-id");
    expect(secret?.location.snippetRedacted).toBe(true);
    expect(secret?.location.snippet).toContain("[redacted]");
  });

  it("exits 0 with --fail-on none while still reporting findings", async () => {
    const result = await cli([
      "scan",
      "fixtures/security",
      "--scanner",
      scannerPath(),
      "--fail-on",
      "none",
    ]);
    expect(result.code).toBe(0);
    expect(parseReport(result.stdout).summary.findings).toBe(5);
  });

  it("restricts the rule set when --rules is given", async () => {
    const result = await cli([
      "scan",
      "fixtures/security",
      "--scanner",
      scannerPath(),
      "--rules",
      "secrets/aws-access-key-id",
    ]);
    expect(result.code).toBe(1);
    const report = parseReport(result.stdout);
    expect(report.findings).toHaveLength(1);
    expect(report.scope.rules.map((rule) => rule.id)).toEqual(["secrets/aws-access-key-id"]);
  });

  it("refuses an unknown rule ID instead of reporting a clean scan", async () => {
    const result = await cli([
      "scan",
      "fixtures/security",
      "--scanner",
      scannerPath(),
      "--rules",
      "security/does-not-exist",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown rule(s): security/does-not-exist");
  });

  it("produces identical findings across runs", async () => {
    const first = parseReport((await cli(["scan", "fixtures/security", "--scanner", scannerPath()])).stdout);
    const second = parseReport((await cli(["scan", "fixtures/security", "--scanner", scannerPath()])).stdout);
    expect(second.findings).toEqual(first.findings);
  });

  it("renders Markdown with limitations and without the raw secret", async () => {
    const result = await cli([
      "scan",
      "fixtures/security",
      "--scanner",
      scannerPath(),
      "--format",
      "markdown",
      "--fail-on",
      "none",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("# CodeCitadel scan report");
    expect(result.stdout).toContain("## Limitations");
    expect(result.stdout).toContain("secrets/aws-access-key-id");
    expect(result.stdout).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("emits SARIF 2.1.0 for the faulty fixture without leaking the secret", async () => {
    const result = await cli([
      "scan",
      "fixtures/security",
      "--scanner",
      scannerPath(),
      "--format",
      "sarif",
      "--fail-on",
      "none",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("AKIAIOSFODNN7EXAMPLE");

    const log = sarifLogSchema.parse(JSON.parse(result.stdout));
    const run = log.runs[0];
    expect(run?.results).toHaveLength(5);
    expect(run?.properties.filesScanned).toBeGreaterThan(0);
    expect(run?.tool.driver.rules.length).toBeGreaterThanOrEqual(5);
    for (const entry of run?.results ?? []) {
      expect(run?.tool.driver.rules[entry.ruleIndex]?.id).toBe(entry.ruleId);
    }
  });

  it("rejects an unusable scanner path with exit code 2", async () => {
    const result = await cli([
      "scan",
      "fixtures/clean",
      "--scanner",
      path.join(repoRoot, "does-not-exist"),
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Cannot find the CodeCitadel scanner binary");
  });

  it("rejects an invalid --fail-on value with exit code 2", async () => {
    const result = await cli(["scan", "fixtures/clean", "--fail-on", "blocker"]);
    expect(result.code).toBe(2);
  });
});

describe("codecitadel doctor", () => {
  it("reports a usable environment as JSON", async () => {
    const result = await cli(["doctor", "--format", "json", "--scanner", scannerPath()]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: Array<{ name: string; status: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.checks.find((check) => check.name === "scanner protocol")?.status).toBe("ok");
  });

  it("fails when the scanner binary is missing", async () => {
    const result = await cli(["doctor", "--scanner", path.join(repoRoot, "missing-binary")]);
    expect(result.code).toBe(2);
    expect(result.stderr + result.stdout).toContain("scanner");
  });
});
