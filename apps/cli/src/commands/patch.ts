import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EXECUTION_SCHEMA_VERSION,
  EXIT_CODES,
  PATCH_VERIFICATION_SCHEMA_VERSION,
  REQUIREMENT_DOCUMENT_FILE,
  patchVerificationReportSchema,
  testRunReportSchema,
  type ExitCode,
  type PatchVerificationReport,
  type RequirementDocument,
  type TestRunReport,
} from "@codecitadel/contracts";
import {
  compareExecutionReports,
  decidePatchVerdict,
  evaluateRequirements,
  inspectPatch,
  type InspectablePatchFile,
} from "@codecitadel/core";
import {
  applyPatch,
  createSourceCopy,
  executeTests,
  parseUnifiedDiff,
  EnvironmentError,
  PatchApplyError,
  PatchParseError,
  RunnerNotFoundError,
  SourceCopyLimitError,
  type ExecuteTestsResult,
  type ParsedPatch,
  type PatchFile,
} from "@codecitadel/executor";

import { UsageError, parsePositiveInt } from "../errors.js";
import { parseEnvNames, requireEnvNamesSet } from "../options.js";
import { renderPatchVerificationText } from "../render-patch.js";
import { readRequirementDocument, requirementDocumentPath } from "../requirement-file.js";
import { readRunReport } from "../run-report-file.js";

const FORMATS = ["text", "json"] as const;
type Format = (typeof FORMATS)[number];

const RUNNER_CONFIG_NOTE =
  "Runner and compiler configuration in the patch was applied to the copy, so the post-patch run used that configuration.";

function parseFormat(value: string | undefined): Format {
  const format = value ?? "text";
  if (!FORMATS.includes(format as Format)) {
    throw new UsageError(
      `--format must be one of ${FORMATS.join(", ")} for patch verify, received "${format}".`,
    );
  }
  return format as Format;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function toInspectable(file: PatchFile): InspectablePatchFile {
  const status =
    file.oldPath === null ? "created" : file.newPath === null ? "deleted" : "modified";
  const target = status === "deleted" ? file.oldPath : file.newPath;
  if (target === null) {
    throw new UsageError("A patch file header has no usable path.");
  }

  const added: InspectablePatchFile["added"][number][] = [];
  const removed: InspectablePatchFile["removed"][number][] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "added") {
        added.push({ text: line.text, line: line.newLine });
      } else if (line.kind === "removed") {
        removed.push({ text: line.text, line: line.oldLine });
      }
    }
  }

  return { path: target, status, added, removed };
}

function buildLimitations(input: {
  applied: boolean;
  requirementsPath: string | null;
  before: TestRunReport;
  execution: ExecuteTestsResult | null;
}): string[] {
  const limitations: string[] = [
    "The patch was applied to a disposable copy under the OS temp directory, which was then copied again for execution. The checkout was never modified, and nothing was applied to it.",
    "Only the test files selected by the stored before report were executed. A test file the patch adds, renames, or removes from that selection was not run.",
    "The copy links node_modules from the checkout instead of installing dependencies, so dependency changes in the patch (including lockfile edits) were not installed.",
    "Test outcomes are the runner's normalized per-test statuses with bounded messages; assertion detail, coverage, and full logs are not retained.",
    "No CPU, memory, network, or filesystem sandbox is applied; this is a disposable directory, not a container.",
    "A passing run is evidence for these tests in this environment. It is not proof that the patch is correct or complete.",
    "Weakening signals block a verified verdict without an override: a patch that edits the requirement document, changes runner configuration or ignore rules, deletes a test file, skips or focuses a test, suppresses a diagnostic, or removes assertions cannot verify itself.",
  ];

  if (input.before.impact.tests.selected.length === 0) {
    limitations.push(
      "The before report selected no test file, so there is nothing to execute after the patch.",
    );
  }
  if (!input.applied) {
    limitations.push(
      "No test was executed because the patch did not apply; the tree it was generated from differs from this checkout.",
    );
  }
  if (input.requirementsPath === null) {
    limitations.push(
      `No requirement document was found at ${REQUIREMENT_DOCUMENT_FILE}, so accepted requirements were not evaluated.`,
    );
  }
  if (input.execution !== null) {
    for (const note of input.execution.notes) {
      limitations.push(`Runner note: ${note}`);
    }
  }

  return limitations;
}

export interface PatchVerifyCommandOptions {
  before?: string;
  requirements?: string;
  format?: string;
  out?: string;
  runner?: string;
  timeoutMs?: string;
  env?: string;
}

/**
 * Verifies one patch against the unchanged test selection of a stored run.
 *
 * The experiment is deliberately narrow, because a wider one is not evidence:
 * the before report fixes the selection and the change classification, the patch
 * is applied only inside a disposable copy, and the post-patch run executes the
 * exact same tests. Acceptance and checks are read from the checkout's committed
 * requirement document, so a patch cannot amend what it is being judged against.
 *
 * Exit codes: 0 when the patch is verified, 1 when it is not verified, 2 when the
 * patch did not apply or the result is inconclusive.
 */
export async function runPatchVerifyCommand(
  patchArgument: string,
  options: PatchVerifyCommandOptions,
): Promise<ExitCode> {
  if (!options.before) {
    throw new UsageError(
      "patch verify requires --before <run-report.json>: the stored run whose selection is re-executed unchanged.",
    );
  }

  const format = parseFormat(options.format);
  const timeoutMs =
    options.timeoutMs === undefined
      ? undefined
      : parsePositiveInt(options.timeoutMs, "--timeout-ms");

  const before = await readRunReport(options.before);

  // The post-patch run re-executes the stored selection, so it needs the same
  // resources the before run needed; an unset name is refused before copying.
  const passthroughEnv = parseEnvNames(options.env);
  requireEnvNamesSet(passthroughEnv);

  let patchText: string;
  try {
    patchText = await readFile(patchArgument, "utf8");
  } catch (error) {
    throw new UsageError(
      `Cannot read the patch at ${patchArgument}: ${(error as Error).message}`,
    );
  }

  let parsed: ParsedPatch;
  try {
    parsed = parseUnifiedDiff(patchText);
  } catch (error) {
    if (error instanceof PatchParseError) {
      throw new UsageError(error.message);
    }
    throw error;
  }

  const inspection = inspectPatch(parsed.files.map(toInspectable));
  const digest = `sha256:${createHash("sha256").update(patchText).digest("hex")}`;
  const root = path.resolve(before.root);

  const explicitDocument =
    options.requirements === undefined ? null : requirementDocumentPath(options.requirements);
  const documentFile = explicitDocument ?? path.join(root, REQUIREMENT_DOCUMENT_FILE);

  let document: RequirementDocument | null = null;
  if (await exists(documentFile)) {
    document = await readRequirementDocument(documentFile);
  } else if (explicitDocument !== null) {
    throw new UsageError(`There is no requirement document at ${explicitDocument}.`);
  }

  const requirementsBefore =
    document === null ? null : evaluateRequirements({ document, report: before });

  if (!(await exists(root))) {
    throw new UsageError(
      `The before report analyzed ${root}, which does not exist here. Re-create the run report in this checkout first.`,
    );
  }

  let applyError: string | null = null;
  let execution: ExecuteTestsResult | null = null;

  let copy: Awaited<ReturnType<typeof createSourceCopy>>;
  try {
    copy = await createSourceCopy(root);
  } catch (error) {
    if (error instanceof SourceCopyLimitError) {
      throw new UsageError(error.message);
    }
    throw error;
  }
  try {
    try {
      await applyPatch(copy.dir, parsed);
    } catch (error) {
      if (error instanceof PatchApplyError) {
        applyError = error.message;
      } else {
        throw error;
      }
    }

    if (applyError === null) {
      try {
        execution = await executeTests({
          root: copy.dir,
          testFiles: before.impact.tests.selected.map((entry) => entry.path),
          isolation: "source-copy",
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
    }
  } finally {
    await copy.dispose();
  }

  let after: TestRunReport | null = null;
  let comparison: PatchVerificationReport["comparison"] = null;
  let requirementsAfter: PatchVerificationReport["requirements"] = null;
  const requirementRegressions: string[] = [];

  if (execution !== null) {
    after = testRunReportSchema.parse({
      schemaVersion: EXECUTION_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      // The analyzed root stays the checkout: it is the tree the patch targets.
      root: before.root,
      impact: before.impact,
      record: execution.record,
      results: execution.results,
      limitations: [
        "The selection is the test list stored in the before report; tests the patch adds were not executed.",
        ...execution.notes,
      ],
    });

    comparison = compareExecutionReports({ before, after });

    if (document !== null) {
      requirementsAfter = evaluateRequirements({ document, report: after });
      const beforeVerdicts = new Map(
        (requirementsBefore?.requirements ?? []).map((entry) => [entry.id, entry.verdict]),
      );
      for (const entry of requirementsAfter.requirements) {
        if (beforeVerdicts.get(entry.id) === "met" && entry.verdict !== "met") {
          requirementRegressions.push(entry.id);
        }
      }
    }
  }

  const decision = decidePatchVerdict({
    applied: applyError === null,
    applyError,
    afterStatus: execution === null ? null : execution.record.status,
    comparison,
    requirementRegressions,
    inspection,
  });

  const limitations = buildLimitations({
    applied: applyError === null,
    requirementsPath: document === null ? null : documentFile,
    before,
    execution,
  });
  if (inspection.files.some((file) => file.kind === "runner-config")) {
    limitations.push(RUNNER_CONFIG_NOTE);
  }

  const report = patchVerificationReportSchema.parse({
    schemaVersion: PATCH_VERIFICATION_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    root: before.root,
    verdict: decision.verdict,
    reason: decision.reason,
    patch: {
      digest,
      files: parsed.files.length,
      addedLines: parsed.files.reduce((total, file) => total + file.addedLines, 0),
      removedLines: parsed.files.reduce((total, file) => total + file.removedLines, 0),
    },
    inspection,
    comparison,
    requirements: requirementsAfter,
    requirementRegressions,
    after,
    limitations,
  } satisfies PatchVerificationReport);

  const rendered =
    format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderPatchVerificationText(report);

  if (options.out) {
    await writeFile(options.out, rendered, "utf8");
    process.stderr.write(`report written to ${options.out}\n`);
  } else {
    process.stdout.write(rendered);
  }

  process.stderr.write(
    `${report.verdict}: ${report.reason}\n` +
      `patch ${digest.slice(0, 21)}… ${report.patch.files} file(s), ` +
      `+${report.patch.addedLines}/-${report.patch.removedLines}, ` +
      `${inspection.weakening} weakening signal(s)\n`,
  );

  switch (report.verdict) {
    case "verified":
      return EXIT_CODES.ok;
    case "not_verified":
      return EXIT_CODES.policyBreach;
    default:
      return EXIT_CODES.error;
  }
}
