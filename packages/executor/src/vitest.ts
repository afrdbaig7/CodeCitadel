import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  CheckStatus,
  ExecutionCounts,
  ExecutionRecord,
  TestResult,
} from "@codecitadel/contracts";

import { createSourceCopy, type SourceCopyLimits } from "./copy.js";
import {
  buildEnvironment,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  runSupervised,
} from "./process.js";
import { aggregateStatus, isolationFor, recordId, summarize } from "./record.js";
import { normalizeVitestReport, stableTestId } from "./vitest-report.js";

export interface ResolvedVitest {
  /** Absolute path of `vitest.mjs`, the file Node executes. */
  entry: string;
  version: string | null;
  /** The `node_modules` directory that holds Vitest, if it can be located. */
  nodeModules: string | null;
}

/** Raised when an explicitly requested runner does not exist. */
export class RunnerNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerNotFoundError";
  }
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function nodeModulesAncestor(ofFile: string): string | null {
  let current = path.dirname(ofFile);
  for (;;) {
    if (path.basename(current) === "node_modules") {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function readVitestVersion(nodeModules: string | null): Promise<string | null> {
  if (nodeModules === null) {
    return null;
  }
  try {
    const raw = await readFile(path.join(nodeModules, "vitest", "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === "string") {
        return version;
      }
    }
  } catch {
    // A missing or unreadable manifest becomes an unknown version, not a failure:
    // the runner itself is what matters.
  }
  return null;
}

/**
 * Finds the Vitest entry point without consulting `PATH`.
 *
 * Resolution walks from the analyzed root upward, which is how Node itself
 * finds a dependency installed at a workspace root. A `--runner` path that does
 * not exist is an error: silently searching elsewhere would execute a different
 * runner than the one the user named.
 */
export async function resolveVitestRunner(input: {
  root: string;
  explicit?: string | undefined;
}): Promise<ResolvedVitest | null> {
  if (input.explicit !== undefined) {
    const entry = path.resolve(input.explicit);
    if (!(await fileExists(entry))) {
      throw new RunnerNotFoundError(
        `Cannot find the Vitest entry point at ${entry}. ` +
          "Point --runner at node_modules/vitest/vitest.mjs in the target project.",
      );
    }
    const nodeModules = nodeModulesAncestor(entry);
    return { entry, version: await readVitestVersion(nodeModules), nodeModules };
  }

  let current = path.resolve(input.root);
  for (;;) {
    const nodeModules = path.join(current, "node_modules");
    const entry = path.join(nodeModules, "vitest", "vitest.mjs");
    if (await fileExists(entry)) {
      return { entry, version: await readVitestVersion(nodeModules), nodeModules };
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export interface ExecuteTestsInput {
  /** Absolute path of the analyzed tree. */
  root: string;
  /** Selected test files, POSIX-relative to `root`. An empty list runs nothing. */
  testFiles: readonly string[];
  isolation?: "source-copy" | "none";
  runner?: string | undefined;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal | undefined;
  now?: () => Date;
  copyLimits?: SourceCopyLimits;
  /**
   * Names of variables to copy from this process into the runner, for checks
   * that need a resource the allow-list does not cover (a demo database URL, for
   * instance). Values are never taken from the caller, and only the names are
   * recorded in the report.
   */
  passthroughEnv?: readonly string[];
}

export interface ExecuteTestsResult {
  record: ExecutionRecord;
  results: TestResult[];
  /** Raw reporter payload kept separately from the normalized results. */
  rawReport: unknown | null;
  /** Facts about this run that the report should surface verbatim. */
  notes: string[];
}

/**
 * Executes the selected test files and returns one normalized result set.
 *
 * Nothing is inferred from exit codes alone: results come from the reporter,
 * and a missing result for a selected file is an error. The process exit code
 * and duration are recorded next to the results as facts.
 */
export async function executeTests(input: ExecuteTestsInput): Promise<ExecuteTestsResult> {
  const now = input.now ?? (() => new Date());
  const isolationMode = input.isolation ?? "source-copy";
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const startedAt = now();
  const startedClock = performance.now();
  const notes: string[] = [];

  // Refuse an unusable name before copying a tree or spawning anything, and say
  // which names the runner actually received. A check that silently ran without
  // the database URL it asked for would look like a passing check.
  const environment = buildEnvironment(input.passthroughEnv ?? []);
  if (environment.forwarded.length > 0) {
    notes.push(
      `Forwarded environment variables by name: ${environment.forwarded.join(", ")}. Their values are not recorded in this report.`,
    );
  }
  for (const name of environment.missing) {
    notes.push(
      `The requested environment variable ${name} was not set for this run, so the runner did not receive it.`,
    );
  }

  const buildRecord = (
    fields: Pick<ExecutionRecord, "status" | "exitCode" | "command" | "isolation" | "detail"> & {
      counts: ExecutionCounts;
      runnerVersion?: string | null;
    },
  ): ExecutionRecord => ({
    id: recordId(`${input.root}\u0000${startedAt.toISOString()}\u0000${randomUUID()}`),
    runner: "vitest",
    runnerVersion: fields.runnerVersion ?? null,
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    durationMs: Math.max(0, Math.round(performance.now() - startedClock)),
    startedAt: startedAt.toISOString(),
    status: fields.status,
    exitCode: fields.exitCode,
    command: fields.command,
    counts: fields.counts,
    isolation: fields.isolation,
    detail: fields.detail,
  });

  if (input.testFiles.length === 0) {
    return {
      record: buildRecord({
        status: "skipped",
        exitCode: null,
        command: [],
        counts: summarize([]),
        isolation: isolationFor("none", input.root, []),
        detail: "No test file was selected, so nothing was executed.",
      }),
      results: [],
      rawReport: null,
      notes: ["Selection was empty: a change no test can see is reported as skipped, never as passed."],
    };
  }

  const runner = await resolveVitestRunner({ root: input.root, explicit: input.runner });

  if (runner === null) {
    const detail =
      "No Vitest installation was found in the analyzed root or its ancestors. " +
      "Install Vitest in the project, or pass --runner <path-to-vitest.mjs>.";
    return {
      record: buildRecord({
        status: "unsupported",
        exitCode: null,
        command: [],
        counts: summarize([]),
        isolation: isolationFor("none", input.root, []),
        detail,
      }),
      results: input.testFiles.map((file) => ({
        id: stableTestId(file, "(not run)"),
        file,
        name: "(not run)",
        status: "unsupported" as const,
        durationMs: null,
        message: detail,
      })),
      rawReport: null,
      notes: [detail],
    };
  }

  let executionRoot = input.root;
  let sharedPaths: string[] = [];
  let copy: Awaited<ReturnType<typeof createSourceCopy>> | null = null;
  let artifactsDir: string | null = null;

  try {
    if (isolationMode === "source-copy") {
      copy = await createSourceCopy(input.root, input.copyLimits);
      executionRoot = copy.dir;
      sharedPaths = copy.sharedPaths;

      // Vitest may live above the analyzed root (a workspace). Link it in so the
      // runner and the project's imports resolve from the copy.
      const copyNodeModules = path.join(executionRoot, "node_modules");
      if (runner.nodeModules !== null && !(await fileExists(copyNodeModules))) {
        await symlink(
          runner.nodeModules,
          copyNodeModules,
          process.platform === "win32" ? "junction" : "dir",
        );
        sharedPaths = [...sharedPaths, "node_modules"];
      }
    }

    artifactsDir = await mkdtemp(path.join(tmpdir(), "codecitadel-run-"));
    const reportPath = path.join(artifactsDir, "vitest.json");

    const command = [
      process.execPath,
      runner.entry,
      "run",
      "--reporter=json",
      `--outputFile=${reportPath}`,
      "--no-color",
      ...input.testFiles,
    ];

    const outcome = await runSupervised(command, {
      cwd: executionRoot,
      timeoutMs,
      maxOutputBytes,
      signal: input.signal,
      env: environment.env,
    });

    let rawReport: unknown | null = null;
    if (outcome.status === "exited") {
      try {
        const raw = await readFile(reportPath, "utf8");
        rawReport = JSON.parse(raw);
      } catch {
        rawReport = null;
      }
    }

    if (outcome.spawnError !== null) {
      notes.push(`The runner could not be started: ${outcome.spawnError.message}`);
    }
    if (outcome.outputTruncated) {
      notes.push(`Runner output was truncated at ${maxOutputBytes} bytes.`);
    }

    let results: TestResult[];
    if (outcome.status === "exited") {
      const normalized = normalizeVitestReport({
        report: rawReport,
        selectedFiles: input.testFiles,
        root: executionRoot,
        exitCode: outcome.exitCode,
      });
      results = normalized.results;
      notes.push(...normalized.notes);
    } else {
      results = [];
      notes.push(
        outcome.status === "timed_out"
          ? `The runner was killed after ${timeoutMs} ms; no test results were observed.`
          : "The run was cancelled; no test results were observed.",
      );
    }

    const counts = summarize(results);
    const status: CheckStatus =
      outcome.spawnError !== null ? "errored" : aggregateStatus(outcome.status, counts);

    const detail = (() => {
      if (status === "passed") {
        return null;
      }
      if (status === "failed") {
        return `${counts.failed} test(s) failed.`;
      }
      if (status === "timed_out") {
        return `The runner was killed after ${timeoutMs} ms.`;
      }
      if (status === "cancelled") {
        return "The run was cancelled by the caller.";
      }
      if (outcome.spawnError !== null) {
        return `The runner could not be started: ${outcome.spawnError.message}`;
      }
      if (counts.total === 0) {
        return `The runner exited with code ${outcome.exitCode ?? "unknown"} without producing a result for the selected tests.`;
      }
      return `${counts.errored} selected test file(s) produced no usable result.`;
    })();

    if (status === "errored" && outcome.stderr.trim().length > 0) {
      const firstLine = outcome.stderr.trim().split(/\r?\n/)[0]?.trim();
      if (firstLine !== undefined && firstLine.length > 0) {
        notes.push(`Runner stderr: ${firstLine.slice(0, 400)}`);
      }
    }

    return {
      record: buildRecord({
        status,
        exitCode: outcome.exitCode,
        command,
        counts,
        runnerVersion: runner.version,
        isolation: isolationFor(isolationMode, input.root, sharedPaths),
        detail,
      }),
      results,
      rawReport,
      notes,
    };
  } finally {
    if (copy !== null) {
      await copy.dispose();
    }
    if (artifactsDir !== null) {
      await rm(artifactsDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
