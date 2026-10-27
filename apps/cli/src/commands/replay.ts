import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EVIDENCE_BUNDLE_MAX_BYTES,
  EXIT_CODES,
  testFingerprint,
  type ExitCode,
  type ReplayReport,
} from "@codecitadel/contracts";
import {
  BundleValidationError,
  decideReplayVerdict,
  validateEvidenceBundle,
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
import { renderReplayText } from "../render-evidence.js";

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export interface ReplayCommandOptions {
  runner?: string;
  env?: string;
  out?: string;
  timeoutMs?: string;
  format?: string;
}

/**
 * `codecitadel replay <bundle> [path] [options]`
 *
 * Replays a stored evidence bundle against a target repository:
 * 1. Strictly validates the bundle schema, size limits, and artifact digests before executing anything.
 * 2. Enforces required environment variables and runner boundaries.
 * 3. Re-executes the check in an isolated disposable copy.
 * 4. Compares observed outcome against the original claim: confirmed, diverged, or inconclusive.
 */
export async function runReplayCommand(
  bundlePath: string,
  pathArgument: string | undefined,
  options: ReplayCommandOptions,
): Promise<ExitCode> {
  const format = options.format ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be text or json, received "${format}".`);
  }

  const timeoutMs =
    options.timeoutMs === undefined ? undefined : parsePositiveInt(options.timeoutMs, "--timeout-ms");

  const resolvedBundlePath = path.resolve(bundlePath);
  if (!(await fileExists(resolvedBundlePath))) {
    throw new UsageError(`Evidence bundle at ${bundlePath} does not exist.`);
  }

  let bundleText: string;
  try {
    bundleText = await readFile(resolvedBundlePath, "utf8");
  } catch (error) {
    throw new UsageError(`Failed to read bundle at ${bundlePath}: ${(error as Error).message}`);
  }

  const bundleBytes = Buffer.byteLength(bundleText, "utf8");
  if (bundleBytes > EVIDENCE_BUNDLE_MAX_BYTES) {
    throw new UsageError(
      `Evidence bundle at ${bundlePath} is ${bundleBytes} bytes, exceeding the maximum allowed limit of ${EVIDENCE_BUNDLE_MAX_BYTES} bytes.`,
    );
  }

  let bundle;
  try {
    bundle = validateEvidenceBundle(bundleText);
  } catch (error) {
    if (error instanceof BundleValidationError) {
      throw new UsageError(error.message);
    }
    throw error;
  }

  const root = path.resolve(pathArgument ?? bundle.target.root);
  const rootStats = await lstat(root).catch(() => null);
  if (rootStats === null || !rootStats.isDirectory()) {
    throw new UsageError(`Target repository at ${root} does not exist or is not a directory.`);
  }

  // Parse passthrough environment variables
  const userEnv = parseEnvNames(options.env);
  const mergedEnv = Array.from(new Set([...bundle.permissions.env, ...userEnv]));
  requireEnvNamesSet(mergedEnv);

  let replayReport: ReplayReport;

  if (bundle.kind === "reproduction") {
    if (!bundle.claim.check) {
      throw new UsageError("Reproduction bundle is missing check metadata.");
    }

    const checkFile = bundle.claim.check.file;
    let execution: ExecuteTestsResult | null = null;

    try {
      execution = await executeTests({
        root,
        testFiles: [checkFile],
        isolation: "source-copy",
        passthroughEnv: mergedEnv,
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

    const fingerprint = bundle.claim.check.fingerprint;
    const result = execution.results.find((candidate) => candidate.id === fingerprint) ?? null;

    let replayedVerdict = "inconclusive";
    if (execution.record.status === "passed" || execution.record.status === "failed") {
      if (result !== null) {
        if (result.status === "failed") {
          replayedVerdict = "reproduced";
        } else if (result.status === "passed") {
          replayedVerdict = "not_reproduced";
        }
      }
    }

    replayReport = decideReplayVerdict(
      bundle,
      {
        verdict: replayedVerdict,
        status: execution.record.status,
        message: result?.message ?? execution.record.detail,
        exitCode: execution.record.exitCode,
        durationMs: execution.record.durationMs,
      },
      bundleBytes,
    );
  } else if (bundle.kind === "run") {
    // Replay test run selection
    const rawReport = bundle.report as { impact?: { changed?: { path: string }[] } };
    const changedFiles = rawReport?.impact?.changed?.map((c) => c.path) ?? [];
    let execution: ExecuteTestsResult | null = null;

    try {
      execution = await executeTests({
        root,
        testFiles: changedFiles,
        isolation: "source-copy",
        passthroughEnv: mergedEnv,
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

    replayReport = decideReplayVerdict(
      bundle,
      {
        verdict: execution.record.status,
        status: execution.record.status,
        message: execution.record.detail,
        exitCode: execution.record.exitCode,
        durationMs: execution.record.durationMs,
      },
      bundleBytes,
    );
  } else {
    throw new UsageError(`Replaying bundle kind "${bundle.kind}" is not yet supported.`);
  }

  if (options.out !== undefined) {
    const outPath = path.resolve(options.out);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(replayReport, null, 2) + "\n", "utf8");
  }

  if (format === "json") {
    process.stdout.write(JSON.stringify(replayReport, null, 2) + "\n");
  } else {
    process.stdout.write(renderReplayText(replayReport));
  }

  if (replayReport.verdict === "confirmed") {
    return EXIT_CODES.ok;
  }
  if (replayReport.verdict === "diverged") {
    return EXIT_CODES.policyBreach;
  }
  return EXIT_CODES.error;
}
