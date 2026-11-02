import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { mutationReportSchema, type MutationReport } from "@codecitadel/contracts";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliEntry = path.join(repoRoot, "apps", "cli", "dist", "index.js");
const weakFixture = path.join(repoRoot, "fixtures", "mutation", "weak");
const strongFixture = path.join(repoRoot, "fixtures", "mutation", "strong");
const vitestRunner = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");

const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-mutate-e2e-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliEntry, ...args],
      {
        cwd: repoRoot,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? 2,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describe("codecitadel mutate (E2E)", () => {
  it("detects surviving mutants on weak test suites with 0.0% score", async () => {
    const result = await cli([
      "mutate",
      weakFixture,
      "--runner",
      vitestRunner,
      "--format",
      "text",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("CodeCitadel Mutation Testing Report");
    expect(result.stdout).toContain("Mutation score:    0.0%");
    expect(result.stdout).toContain("Survived (gap):    2");
    expect(result.stdout).toContain("ComparisonOperator");
    expect(result.stdout).toContain("ArithmeticOperator");
  });

  it("kills all mutants on strong test suites with 100.0% score", async () => {
    const result = await cli([
      "mutate",
      strongFixture,
      "--runner",
      vitestRunner,
      "--format",
      "text",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Mutation score:    100.0%");
    expect(result.stdout).toContain("Killed (caught):   2");
    expect(result.stdout).toContain("Survived (gap):    0");
    expect(result.stdout).toContain("No mutants survived!");
  });

  it("enforces threshold and exits with policy breach code when score is below minimum", async () => {
    const result = await cli([
      "mutate",
      weakFixture,
      "--runner",
      vitestRunner,
      "--threshold",
      "80",
    ]);

    expect(result.code).toBe(1); // EXIT_CODES.policyBreach
    expect(result.stderr).toContain("breached threshold 80%");
  });

  it("passes threshold check when strong test suite satisfies minimum score", async () => {
    const result = await cli([
      "mutate",
      strongFixture,
      "--runner",
      vitestRunner,
      "--threshold",
      "80",
    ]);

    expect(result.code).toBe(0);
  });

  it("outputs valid JSON conforming to mutationReportSchema and writes --out artifact", async () => {
    const outFile = path.join(scratch, "mutation-report.json");
    const result = await cli([
      "mutate",
      strongFixture,
      "--runner",
      vitestRunner,
      "--format",
      "json",
      "--out",
      outFile,
    ]);

    expect(result.code).toBe(0);
    const parsedStdout: unknown = JSON.parse(result.stdout);
    const validStdout = mutationReportSchema.safeParse(parsedStdout);
    expect(validStdout.success).toBe(true);

    const fileContent = readFileSync(outFile, "utf8");
    const parsedFile: unknown = JSON.parse(fileContent);
    const validFile = mutationReportSchema.safeParse(parsedFile);
    expect(validFile.success).toBe(true);

    if (validFile.success) {
      expect(validFile.data.summary.mutationScore).toBe(100);
      expect(validFile.data.summary.killed).toBe(2);
      expect(validFile.data.summary.survived).toBe(0);
    }
  });

  it("rejects invalid format argument", async () => {
    const result = await cli([
      "mutate",
      strongFixture,
      "--format",
      "yaml",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--format must be one of text, json, received "yaml"');
  });

  it("rejects invalid threshold value", async () => {
    const result = await cli([
      "mutate",
      strongFixture,
      "--threshold",
      "150",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--threshold must be a number between 0 and 100");
  });
});
