import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { codeCitadelReportSchema, sarifLogSchema } from "@codecitadel/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const runnerScript = path.join(repoRoot, "scripts", "run-action.mjs");
const scratchDir = path.join(repoRoot, ".codecitadel", "action-test-scratch");

const CLEAN_FIXTURE = path.join(repoRoot, "fixtures", "clean");
const FAULTY_FIXTURE = path.join(repoRoot, "fixtures", "security");

interface ActionRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runActionScript(env: Record<string, string>): Promise<ActionRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [runnerScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ACTION_PATH: repoRoot,
        ...env,
      },
      timeout: 30_000,
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

describe("CodeCitadel GitHub Action runner", () => {
  let outputFile: string;
  let summaryFile: string;
  let sarifFile: string;
  let reportFile: string;

  beforeEach(() => {
    mkdirSync(scratchDir, { recursive: true });
    outputFile = path.join(scratchDir, `github-output-${Date.now()}.txt`);
    summaryFile = path.join(scratchDir, `github-summary-${Date.now()}.md`);
    sarifFile = path.join(scratchDir, `results-${Date.now()}.sarif`);
    reportFile = path.join(scratchDir, `report-${Date.now()}.json`);
    writeFileSync(outputFile, "", "utf8");
    writeFileSync(summaryFile, "", "utf8");
  });

  afterEach(() => {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {}
  });

  it("passes cleanly on a clean fixture, emits valid SARIF, step summary, and outputs", async () => {
    const result = await runActionScript({
      INPUT_PATH: CLEAN_FIXTURE,
      INPUT_FAIL_ON: "high",
      INPUT_SARIF_FILE: sarifFile,
      INPUT_REPORT_FILE: reportFile,
      INPUT_WRITE_SUMMARY: "true",
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Check passed");

    // Check outputs
    const outputs = readFileSync(outputFile, "utf8");
    expect(outputs).toContain("findings-count=0");
    expect(outputs).toContain("breach-count=0");
    expect(outputs).toContain("verdict=passed");

    // Check SARIF file
    expect(existsSync(sarifFile)).toBe(true);
    const sarifJson = JSON.parse(readFileSync(sarifFile, "utf8"));
    expect(sarifLogSchema.safeParse(sarifJson).success).toBe(true);
    expect(sarifJson.runs[0].results).toHaveLength(0);

    // Check Step Summary
    expect(existsSync(summaryFile)).toBe(true);
    const summaryMd = readFileSync(summaryFile, "utf8");
    expect(summaryMd).toContain("CodeCitadel Verification Summary");
    expect(summaryMd).toContain("**Passed**");
    expect(summaryMd).toContain("Total Findings");

    // Check Report file
    expect(existsSync(reportFile)).toBe(true);
    const reportJson = JSON.parse(readFileSync(reportFile, "utf8"));
    expect(codeCitadelReportSchema.safeParse(reportJson).success).toBe(true);
  });

  it("fails with exit code 1 on faulty fixture when findings breach policy", async () => {
    const result = await runActionScript({
      INPUT_PATH: FAULTY_FIXTURE,
      INPUT_FAIL_ON: "high",
      INPUT_SARIF_FILE: sarifFile,
      INPUT_REPORT_FILE: reportFile,
      INPUT_WRITE_SUMMARY: "true",
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('meet or exceed "high" policy');

    // Check outputs
    const outputs = readFileSync(outputFile, "utf8");
    expect(outputs).toContain("verdict=failed");
    expect(outputs).toMatch(/findings-count=[1-9]\d*/);
    expect(outputs).toMatch(/breach-count=[1-9]\d*/);

    // Check SARIF file has findings
    expect(existsSync(sarifFile)).toBe(true);
    const sarifJson = JSON.parse(readFileSync(sarifFile, "utf8"));
    expect(sarifLogSchema.safeParse(sarifJson).success).toBe(true);
    expect(sarifJson.runs[0].results.length).toBeGreaterThan(0);

    // Check Step Summary has failure warning and details
    const summaryMd = readFileSync(summaryFile, "utf8");
    expect(summaryMd).toContain("**Policy Breached**");
    expect(summaryMd).toContain("Findings Detail");
    expect(summaryMd).toContain("secrets/aws-access-key-id");
  });

  it("exits 0 on faulty fixture when fail-on is set to none while still reporting findings", async () => {
    const result = await runActionScript({
      INPUT_PATH: FAULTY_FIXTURE,
      INPUT_FAIL_ON: "none",
      INPUT_SARIF_FILE: sarifFile,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
    });

    expect(result.code).toBe(0);
    const outputs = readFileSync(outputFile, "utf8");
    expect(outputs).toContain("breach-count=0");
    expect(outputs).toContain("verdict=passed");
    expect(outputs).toMatch(/findings-count=[1-9]\d*/);
  });

  it("uploads report to control plane when upload is enabled", async () => {
    const { startLocalServer } = await import("@codecitadel/api");
    const server = await startLocalServer({
      port: 4419,
      dataDir: path.join(scratchDir, "control-plane"),
      organizationSlug: "ci-org",
    });

    try {
      const result = await runActionScript({
        INPUT_PATH: CLEAN_FIXTURE,
        INPUT_UPLOAD: "true",
        INPUT_SERVER: server.url,
        INPUT_TOKEN: server.token,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Uploading report to CodeCitadel control plane");
      expect(result.stdout).toContain("Check passed");
    } finally {
      await server.close();
    }
  });

  it("rejects an unsupported action command with exit code 2", async () => {
    const result = await runActionScript({
      INPUT_COMMAND: "unsupported-command",
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('command "unsupported-command" is not yet automated');
  });
});
