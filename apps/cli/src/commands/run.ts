import { writeFile } from "node:fs/promises";

import {
  EXIT_CODES,
  EXECUTION_SCHEMA_VERSION,
  testRunReportSchema,
  type ExitCode,
  type ImpactReport,
  type TestRunReport,
} from "@codecitadel/contracts";
import {
  EnvironmentError,
  executeTests,
  RunnerNotFoundError,
  SourceCopyLimitError,
  type ExecuteTestsResult,
} from "@codecitadel/executor";

import { analyzeChanges } from "../analyze.js";
import { UsageError, parsePositiveInt } from "../errors.js";
import { parseEnvNames, requireEnvNamesSet } from "../options.js";
import { renderRunText } from "../render.js";
import { readSnapshot } from "../snapshot-file.js";

export interface RunCommandOptions {
  base?: string;
  format?: string;
  out?: string;
  scanner?: string;
  runner?: string;
  isolation?: string;
  timeoutMs?: string;
  saveRaw?: string;
  env?: string;
}

const FORMATS = ["text", "json"] as const;
type Format = (typeof FORMATS)[number];

const ISOLATION_MODES = ["copy", "none"] as const;
type Isolation = (typeof ISOLATION_MODES)[number];

function parseFormat(value: string | undefined): Format {
  const format = value ?? "text";
  if (!FORMATS.includes(format as Format)) {
    throw new UsageError(
      `--format must be one of ${FORMATS.join(", ")} for run, received "${format}".`,
    );
  }
  return format as Format;
}

function parseIsolation(value: string | undefined): Isolation {
  const mode = value ?? "copy";
  if (!ISOLATION_MODES.includes(mode as Isolation)) {
    throw new UsageError(
      `--isolation must be one of ${ISOLATION_MODES.join(", ")}, received "${mode}". ` +
        'Use "copy" (default) or pass "none" to accept execution in the checkout.',
    );
  }
  return mode as Isolation;
}

function buildLimitations(input: {
  impact: ImpactReport;
  execution: ExecuteTestsResult;
}): string[] {
  const { impact, execution } = input;
  const limitations: string[] = [];

  if (!impact.complete) {
    limitations.push(
      "The module graph was incomplete, so the selected test list is a lower bound: a test that " +
        "could not be reached did not run, and this report cannot say it would have passed.",
    );
  }

  limitations.push(
    execution.record.status === "skipped"
      ? "No test file was selected, so no check executed. A skipped selection is not evidence that the change is safe."
      : "Only the selected test files ran. Test files the module graph could not reach from a change did not run.",
    "A passing result means these tests passed against this tree in this environment. It is not proof that the change is correct, complete, or free of regressions elsewhere.",
    "Results come from the runner's JSON reporter. Coverage, full logs, and assertion-level detail are not retained.",
  );

  for (const note of execution.notes) {
    limitations.push(`Runner note: ${note}`);
  }

  return limitations;
}

/**
 * Executes the tests that can see the changes since a stored snapshot.
 *
 * The command is explicitly an execution path: `scan`, `diff`, and `impact`
 * never run repository code, and this one only runs when asked. Isolation is
 * chosen up front (`copy` by default); there is no silent fallback to the
 * checkout, and the record says which mode was used.
 *
 * Exit codes: 0 when the run passed or nothing was selected, 1 when a test
 * failed, 2 when the run was inconclusive (timed out, cancelled, unsupported,
 * or produced no usable result).
 */
export async function runRunCommand(
  pathArgument: string,
  options: RunCommandOptions,
): Promise<ExitCode> {
  if (!options.base) {
    throw new UsageError("run requires --base <snapshot.json>.");
  }

  const format = parseFormat(options.format);
  const isolation = parseIsolation(options.isolation);
  const timeoutMs =
    options.timeoutMs === undefined
      ? undefined
      : parsePositiveInt(options.timeoutMs, "--timeout-ms");
  const baseSnapshot = await readSnapshot(options.base);

  // A named variable must exist before anything runs: a check that cannot reach
  // its database fails for a setup reason, and that is not a test outcome.
  const passthroughEnv = parseEnvNames(options.env);
  requireEnvNamesSet(passthroughEnv);

  const analysis = await analyzeChanges({
    root: pathArgument,
    baseSnapshot,
    scannerPath: options.scanner,
  });

  let execution: ExecuteTestsResult;
  try {
    execution = await executeTests({
      root: analysis.report.scope.root,
      testFiles: analysis.impact.tests.selected.map((entry) => entry.path),
      isolation: isolation === "copy" ? "source-copy" : "none",
      passthroughEnv,
      ...(options.runner !== undefined ? { runner: options.runner } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  } catch (error) {
    if (
      error instanceof RunnerNotFoundError ||
      error instanceof SourceCopyLimitError ||
      error instanceof EnvironmentError
    ) {
      throw new UsageError(error.message);
    }
    throw error;
  }

  const report = testRunReportSchema.parse({
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    root: analysis.report.scope.root,
    impact: analysis.impact,
    record: execution.record,
    results: execution.results,
    limitations: buildLimitations({ impact: analysis.impact, execution }),
  } satisfies TestRunReport);

  if (options.saveRaw) {
    if (execution.rawReport === null) {
      throw new UsageError(
        `There is no raw runner report to save: ${execution.record.detail ?? "the runner produced no output"}.`,
      );
    }
    try {
      await writeFile(options.saveRaw, `${JSON.stringify(execution.rawReport, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new UsageError(
          `Refusing to overwrite the existing raw report at ${options.saveRaw}. Raw runner output is evidence; write a new file name instead.`,
        );
      }
      throw new UsageError(
        `Cannot write the raw runner report to ${options.saveRaw}: ${(error as Error).message}`,
      );
    }
    process.stderr.write(`raw runner report written to ${options.saveRaw}\n`);
  }

  const rendered = format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderRunText(report);

  if (options.out) {
    await writeFile(options.out, rendered, "utf8");
    process.stderr.write(`report written to ${options.out}\n`);
  } else {
    process.stdout.write(rendered);
  }

  const { record, results } = report;
  process.stderr.write(
    `${record.status}: ${record.counts.passed} passed, ${record.counts.failed} failed, ` +
      `${record.counts.skipped} skipped, ${record.counts.errored} errored, ` +
      `${record.counts.timedOut} timed out, ${record.counts.cancelled} cancelled ` +
      `(${results.length} result(s) from ${analysis.impact.tests.selected.length} selected file(s) ` +
      `in ${record.durationMs}ms, isolation ${record.isolation.mode})\n`,
  );
  if (record.detail !== null) {
    process.stderr.write(`${record.detail}\n`);
  }

  switch (record.status) {
    case "passed":
    case "skipped":
      return EXIT_CODES.ok;
    case "failed":
      return EXIT_CODES.policyBreach;
    default:
      // Inconclusive is an error, not a failure and never a pass.
      return EXIT_CODES.error;
  }
}
