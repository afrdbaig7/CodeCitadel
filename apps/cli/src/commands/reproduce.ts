import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EXIT_CODES,
  REPRODUCTION_SCHEMA_VERSION,
  REPRODUCTION_SOURCE_LIMIT_BYTES,
  REQUIREMENT_DOCUMENT_FILE,
  reproductionExportSchema,
  reproductionSourceBytes,
  reproductionSourceDigest,
  testFingerprint,
  type ExitCode,
  type ReproductionExport,
  type ReproductionReport,
  type ReproductionRequirement,
  type TestResult,
} from "@codecitadel/contracts";
import {
  acceptanceStatusOf,
  decideReproductionVerdict,
  findReproduction,
  ReproductionError,
  validateReproductionPath,
} from "@codecitadel/core";
import {
  EnvironmentError,
  executeTests,
  RunnerNotFoundError,
  SourceCopyLimitError,
  type ExecuteTestsResult,
} from "@codecitadel/executor";

import { UsageError, parsePositiveInt } from "../errors.js";
import { parseEnvNames, requireEnvNamesSet } from "../options.js";
import { renderReproductionExportText, renderReproductionText } from "../render-reproduction.js";
import { readRequirementDocument, requirementDocumentPath } from "../requirement-file.js";
import { readReproductionDocument, readReproductionReport } from "../reproduction-file.js";

const FORMATS = ["text", "json"] as const;
type Format = (typeof FORMATS)[number];

function parseFormat(value: string | undefined, command: string): Format {
  const format = value ?? "text";
  if (!FORMATS.includes(format as Format)) {
    throw new UsageError(
      `--format must be one of ${FORMATS.join(", ")} for ${command}, received "${format}".`,
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

/** True when `candidate` is `parent` itself or below it. */
function isInside(parent: string, candidate: string): boolean {
  const base = path.resolve(parent);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

export interface ReproduceCommandOptions {
  id?: string;
  format?: string;
  out?: string;
  runner?: string;
  timeoutMs?: string;
  requirements?: string;
  env?: string;
}

/**
 * Reads the reproduction's test source, bounded and inside the analyzed root.
 * The source travels with the report so export can verify it ships exactly the
 * bytes the verdict was reached on.
 */
async function readCheckSource(
  root: string,
  relative: string,
): Promise<{ source: string; bytes: number; digest: string }> {
  try {
    validateReproductionPath(relative);
  } catch (error) {
    if (error instanceof ReproductionError) {
      throw new UsageError(error.message);
    }
    throw error;
  }

  const absolute = path.resolve(root, relative);
  if (!isInside(root, absolute)) {
    throw new UsageError(
      `The reproduction file ${relative} resolves outside ${root}. A manifest may only name files in the analyzed tree.`,
    );
  }

  const stats = await lstat(absolute).catch(() => null);
  if (stats === null) {
    throw new UsageError(`The reproduction file ${relative} does not exist in ${root}.`);
  }
  if (!stats.isFile()) {
    throw new UsageError(
      `The reproduction file ${relative} is not a regular file inside ${root}. Symbolic links are refused.`,
    );
  }

  let source: string;
  try {
    source = await readFile(absolute, "utf8");
  } catch (error) {
    throw new UsageError(
      `Cannot read the reproduction file ${relative} as UTF-8: ${(error as Error).message}`,
    );
  }

  const bytes = reproductionSourceBytes(source);
  if (bytes > REPRODUCTION_SOURCE_LIMIT_BYTES) {
    throw new UsageError(
      `The reproduction file ${relative} is ${bytes} bytes, more than the limit of ${REPRODUCTION_SOURCE_LIMIT_BYTES}. ` +
        "A reproduction is a focused check, not a whole suite.",
    );
  }

  return { source, bytes, digest: reproductionSourceDigest(source) };
}

/**
 * Reads the requirement a reproduction is answerable to. A missing document or
 * id is recorded as `missing` rather than treated as approval.
 */
async function readRequirementState(
  root: string,
  requirementId: string | null,
  explicit: string | undefined,
): Promise<ReproductionRequirement | null> {
  if (requirementId === null) {
    return null;
  }

  const explicitPath = explicit === undefined ? null : requirementDocumentPath(explicit);
  const file = explicitPath ?? path.join(root, REQUIREMENT_DOCUMENT_FILE);

  if (!(await exists(file))) {
    if (explicitPath !== null) {
      throw new UsageError(`There is no requirement document at ${explicitPath}.`);
    }
    return { id: requirementId, state: "missing", acceptance: "missing" };
  }

  const document = await readRequirementDocument(file);
  const requirement = document.requirements.find((entry) => entry.id === requirementId);
  if (requirement === undefined) {
    return { id: requirementId, state: "missing", acceptance: "missing" };
  }
  return {
    id: requirement.id,
    state: requirement.state,
    acceptance: acceptanceStatusOf(requirement),
  };
}

function buildLimitations(input: {
  executed: boolean;
  requirement: ReproductionRequirement | null;
  execution: ExecuteTestsResult | null;
}): string[] {
  const limitations: string[] = [
    "The reproduction file ran in a disposable copy under the OS temp directory; the checkout was not modified. Running a reproduction executes repository code, so use it only on a repository you trust.",
    "No CPU, memory, network, or filesystem sandbox is applied. This is a disposable directory, not a container.",
    "The copy links node_modules from the checkout instead of installing dependencies, so the run used the dependencies that are already installed.",
    "Only the named test file was executed. Other tests in that file are reported but not judged, and no other test was selected by change analysis.",
    "A `not_reproduced` verdict means the expected behavior was not observed to fail under this check; it is not proof that no bug exists.",
    "Outcomes come from the runner's normalized per-test statuses with bounded messages. Assertion detail, coverage, and full logs are not retained.",
    "The check source recorded here is the file as read before execution. The report is evidence for this check in this environment, not an independent attestation that the runner reported truthfully.",
  ];

  if (!input.executed) {
    limitations.push(
      "No test was executed because the requirement this reproduction is linked to is not accepted as written. Accept the requirement, then re-run the reproduction.",
    );
  }
  if (input.requirement !== null && input.requirement.acceptance === "stale") {
    limitations.push(
      `The acceptance of "${input.requirement.id}" is stale: the requirement was edited after it was approved, so the reproduction does not answer to the current text.`,
    );
  }
  if (input.execution !== null) {
    for (const note of input.execution.notes) {
      limitations.push(`Runner note: ${note}`);
    }
  }

  return limitations;
}

/**
 * `codecitadel reproduce <manifest> --id <id> [path]`
 *
 * Executes exactly one user-declared check and records what happened. Exit codes
 * follow the project rule that inconclusive is an error: `0` the bug was
 * reproduced, `1` it was not observed, `2` nothing was established or the
 * requirement gate refused.
 */
export async function runReproduceCommand(
  manifestArgument: string,
  pathArgument: string,
  options: ReproduceCommandOptions,
): Promise<ExitCode> {
  if (options.id === undefined) {
    throw new UsageError(
      "reproduce requires --id <reproduction-id>: the manifest may declare several reproductions.",
    );
  }

  const format = parseFormat(options.format, "reproduce");
  const timeoutMs =
    options.timeoutMs === undefined ? undefined : parsePositiveInt(options.timeoutMs, "--timeout-ms");

  const passthroughEnv = parseEnvNames(options.env);
  // Naming a variable means the check needs it: refuse an unset name before
  // anything is copied, so a setup failure cannot become evidence.
  requireEnvNamesSet(passthroughEnv);

  const root = path.resolve(pathArgument);
  const rootStats = await lstat(root).catch(() => null);
  if (rootStats === null || !rootStats.isDirectory()) {
    throw new UsageError(`Cannot reproduce in ${root}: it is not a directory.`);
  }

  const document = await readReproductionDocument(manifestArgument);

  let entry;
  try {
    entry = findReproduction(document, options.id);
  } catch (error) {
    if (error instanceof ReproductionError) {
      throw new UsageError(error.message);
    }
    throw error;
  }

  const check = await readCheckSource(root, entry.file);
  const requirement = await readRequirementState(root, entry.requirement, options.requirements);
  const gateOpen =
    requirement === null ||
    (requirement.state === "accepted" && requirement.acceptance === "current");

  let execution: ExecuteTestsResult | null = null;
  if (gateOpen) {
    try {
      execution = await executeTests({
        root,
        testFiles: [entry.file],
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

  const fingerprint = testFingerprint(entry.file, entry.test);
  const result: TestResult | null =
    execution === null ? null : (execution.results.find((candidate) => candidate.id === fingerprint) ?? null);

  const decision = decideReproductionVerdict({
    requirement,
    executionStatus: execution === null ? null : execution.record.status,
    result,
  });

  const report = {
    schemaVersion: REPRODUCTION_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    root,
    verdict: decision.verdict,
    reason: decision.reason,
    reproduction: {
      id: entry.id,
      statement: entry.statement,
      provenance: entry.provenance,
      requirement: entry.requirement,
    },
    check: {
      file: entry.file,
      test: entry.test,
      fingerprint,
      digest: check.digest,
      bytes: check.bytes,
      source: check.source,
    },
    requirement,
    record: execution === null ? null : execution.record,
    results: execution === null ? [] : execution.results,
    result,
    limitations: buildLimitations({ executed: execution !== null, requirement, execution }),
  } satisfies ReproductionReport;

  const rendered =
    format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderReproductionText(report);

  if (options.out) {
    await writeFile(options.out, rendered, "utf8");
    process.stderr.write(`report written to ${options.out}\n`);
  } else {
    process.stdout.write(rendered);
  }

  process.stderr.write(
    `${report.verdict}: ${report.reason}\n` +
      `check ${entry.file} › ${entry.test} (${fingerprint})\n`,
  );

  switch (report.verdict) {
    case "reproduced":
      return EXIT_CODES.ok;
    case "not_reproduced":
      return EXIT_CODES.policyBreach;
    default:
      return EXIT_CODES.error;
  }
}

export interface ReproduceExportCommandOptions {
  out?: string;
  force?: boolean;
  inRoot?: boolean;
  format?: string;
}

/**
 * `codecitadel reproduce export <report> --out <dir>`
 *
 * Writes the reproduction's test source at its original relative path plus a
 * manifest that names the evidence. The destination is checked three ways: it
 * must stay inside `--out`, it must not be the analyzed checkout unless
 * `--in-root` is explicit, and an existing file is never overwritten silently.
 */
export async function runReproduceExportCommand(
  reportArgument: string,
  options: ReproduceExportCommandOptions,
): Promise<ExitCode> {
  if (options.out === undefined) {
    throw new UsageError(
      "reproduce export requires --out <dir>: the directory the exported test and its manifest are written to.",
    );
  }

  const format = parseFormat(options.format, "reproduce export");
  const report = await readReproductionReport(reportArgument);

  const outDir = path.resolve(options.out);
  try {
    validateReproductionPath(report.check.file);
  } catch (error) {
    if (error instanceof ReproductionError) {
      throw new UsageError(error.message);
    }
    throw error;
  }

  const destination = path.resolve(outDir, report.check.file);
  if (!isInside(outDir, destination)) {
    throw new UsageError(
      `The reproduction file path ${report.check.file} would resolve outside ${outDir}. Refusing to write it.`,
    );
  }

  if (isInside(report.root, destination) && options.inRoot !== true) {
    throw new UsageError(
      `The export destination ${destination} is inside the analyzed tree ${report.root}. ` +
        "Exports are written outside it by default; pass --in-root to place one in the checkout deliberately.",
    );
  }

  const manifestPath = path.join(outDir, `${report.reproduction.id}.reproduction.json`);

  const digest = reproductionSourceDigest(report.check.source);
  if (digest !== report.check.digest) {
    throw new UsageError(
      `The reproduction report at ${reportArgument} is inconsistent: the check digest ` +
        `${report.check.digest.slice(0, 21)}… does not match the source it carries ` +
        `(${digest.slice(0, 21)}…). Re-create the report with \`codecitadel reproduce\`.`,
    );
  }
  if (reproductionSourceBytes(report.check.source) !== report.check.bytes) {
    throw new UsageError(
      `The reproduction report at ${reportArgument} is inconsistent: the recorded byte count does not match its source.`,
    );
  }

  if (options.force !== true) {
    for (const target of [destination, manifestPath]) {
      if (await exists(target)) {
        throw new UsageError(
          `${target} already exists. Pass --force to overwrite it after reviewing the difference.`,
        );
      }
    }
  }

  const manifest = reproductionExportSchema.parse({
    schemaVersion: 1,
    kind: "codecitadel.reproduction-export",
    generatedAt: new Date().toISOString(),
    id: report.reproduction.id,
    statement: report.reproduction.statement,
    provenance: report.reproduction.provenance,
    requirement: report.reproduction.requirement,
    check: {
      file: report.check.file,
      test: report.check.test,
      fingerprint: report.check.fingerprint,
      digest: report.check.digest,
    },
    evidence: {
      schemaVersion: report.schemaVersion,
      generatedAt: report.generatedAt,
      root: report.root,
      verdict: report.verdict,
      execution:
        report.record === null
          ? null
          : {
              runner: report.record.runner,
              runnerVersion: report.record.runnerVersion,
              nodeVersion: report.record.nodeVersion,
              platform: report.record.platform,
              isolation: report.record.isolation.mode,
              startedAt: report.record.startedAt,
            },
    },
    files: [{ path: report.check.file, digest: report.check.digest, bytes: report.check.bytes }],
    limitations: [
      "The exported file is the reproduction's test source exactly as recorded. It imports nothing from CodeCitadel and no helper is provided.",
      "It runs with the target project's own dependencies, test runner, and runner configuration; it was recorded because they were present, not because they are bundled.",
      "Its relative imports assume it is placed at the same relative path inside a checkout of the same project.",
      "The verdict in this manifest belongs to the run recorded in the evidence reference. A later pass or failure is new evidence, not a rewrite of that run.",
    ],
  } satisfies ReproductionExport);

  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, report.check.source, "utf8");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  if (report.check.source.includes("@codecitadel/")) {
    process.stderr.write(
      "warning: the exported test imports a CodeCitadel package. It will not run without this repository's packages installed.\n",
    );
  }

  const written = { test: destination, manifest: manifestPath };
  process.stdout.write(
    format === "json"
      ? `${JSON.stringify(manifest, null, 2)}\n`
      : renderReproductionExportText(manifest, written),
  );
  process.stderr.write(
    `exported ${report.check.file} and ${report.reproduction.id}.reproduction.json to ${outDir}\n`,
  );

  return EXIT_CODES.ok;
}
