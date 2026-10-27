import path from "node:path";

import { testFingerprint, type CheckStatus, type TestResult } from "@codecitadel/contracts";
import { z } from "zod";

/**
 * Vitest's JSON reporter is a raw tool result. It is validated before use for
 * the same reason scanner records are: untrusted output must not become a
 * report just because it happened to parse as JSON.
 *
 * The schema is narrow about the fields this adapter reads and permissive about
 * everything else, because a reporter may add fields between minor versions.
 * Any *missing* result for a selected file is a reported error, never a pass.
 */
const assertionResultSchema = z.looseObject({
  fullName: z.string().optional(),
  title: z.string().optional(),
  status: z.string(),
  duration: z.number().nullable().optional(),
  failureMessages: z.array(z.string()).optional(),
});

const fileResultSchema = z.looseObject({
  name: z.string().min(1),
  status: z.string().optional(),
  message: z.string().optional(),
  assertionResults: z.array(assertionResultSchema).optional(),
});

export const vitestJsonReportSchema = z.looseObject({
  testResults: z.array(fileResultSchema).optional(),
});

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const MAX_MESSAGE_CHARS = 400;

/**
 * Test IDs are stable across line moves; they change when the name changes.
 *
 * The definition lives in `@codecitadel/contracts` so requirement checks can
 * name the same test without importing the executor; this alias keeps the
 * adapter's own vocabulary.
 */
export const stableTestId = testFingerprint;

/**
 * Reporter paths are absolute and point into the disposable copy. The report
 * should describe the analyzed tree, so paths are rewritten relative to it
 * using forward slashes on every platform.
 */
export function normalizeResultPath(reportedPath: string, root: string): string {
  const absolute = path.resolve(reportedPath);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return absolute.split(path.sep).join("/");
  }
  return relative.split(path.sep).join("/");
}

function mapStatus(raw: string): CheckStatus {
  switch (raw) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "pending":
    case "todo":
    case "skipped":
    case "disabled":
      return "skipped";
    default:
      return "errored";
  }
}

/** Bounded first line of a runner message; ANSI colour codes are stripped. */
export function boundMessage(text: string | undefined): string | null {
  if (text === undefined) {
    return null;
  }
  const cleaned = text.replace(ANSI, "");
  const firstLine = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) {
    return null;
  }
  return firstLine.length > MAX_MESSAGE_CHARS
    ? `${firstLine.slice(0, MAX_MESSAGE_CHARS)}…`
    : firstLine;
}

export interface NormalizeInput {
  /** Parsed JSON from the reporter, or `null` when no report was produced. */
  report: unknown;
  /** Selected test files, POSIX-relative to `root`. */
  selectedFiles: readonly string[];
  /** Root the reporter ran in (the disposable copy). */
  root: string;
  exitCode: number | null;
}

export interface NormalizedResults {
  results: TestResult[];
  /** Facts about the normalization that the record should keep. */
  notes: string[];
}

function errorResult(file: string, name: string, message: string): TestResult {
  return {
    id: stableTestId(file, name),
    file,
    name,
    status: "errored",
    durationMs: null,
    message,
  };
}

/**
 * Turns a reporter payload into one result per test, and one result per selected
 * file the reporter never mentioned.
 */
export function normalizeVitestReport(input: NormalizeInput): NormalizedResults {
  const notes: string[] = [];
  const selected = [...new Set(input.selectedFiles)].sort((left, right) => left.localeCompare(right));

  if (input.report === null) {
    notes.push(
      `The runner produced no JSON report (exit code ${input.exitCode === null ? "unknown" : input.exitCode}); ` +
        "every selected file is reported as errored rather than passed.",
    );
    return {
      results: selected.map((file) =>
        errorResult(file, "(no result reported)", "The runner produced no JSON report for this file."),
      ),
      notes,
    };
  }

  const parsed = vitestJsonReportSchema.safeParse(input.report);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    notes.push(
      `The runner's JSON report did not match the expected shape (${issue?.message ?? "invalid report"}); ` +
        "every selected file is reported as errored.",
    );
    return {
      results: selected.map((file) =>
        errorResult(file, "(unreadable report)", "The runner's JSON report could not be interpreted."),
      ),
      notes,
    };
  }

  const byFile = new Map<string, z.infer<typeof fileResultSchema>>();
  for (const fileResult of parsed.data.testResults ?? []) {
    byFile.set(normalizeResultPath(fileResult.name, input.root), fileResult);
  }

  const results: TestResult[] = [];
  const occurrences = new Map<string, number>();

  for (const file of selected) {
    const entry = byFile.get(file);
    if (entry === undefined) {
      results.push(
        errorResult(
          file,
          "(no result reported)",
          "The runner did not report a result for this file; it may have been filtered out, " +
            "failed to collect, or crashed before reaching it.",
        ),
      );
      continue;
    }

    const assertions = entry.assertionResults ?? [];
    if (assertions.length === 0) {
      if (entry.status === "failed") {
        results.push(
          errorResult(
            file,
            "(suite)",
            boundMessage(entry.message) ??
              "The runner reported the suite as failed without individual test results.",
          ),
        );
      } else {
        results.push({
          id: stableTestId(file, "(no tests)"),
          file,
          name: "(no tests)",
          status: "skipped",
          durationMs: null,
          message: "The runner reported no tests in this file.",
        });
      }
      continue;
    }

    for (const assertion of assertions) {
      const name = assertion.fullName ?? assertion.title ?? "(unnamed test)";
      const key = `${file}\u0000${name}`;
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);

      const status = mapStatus(assertion.status);
      results.push({
        id: stableTestId(file, name, occurrence),
        file,
        name,
        status,
        durationMs:
          typeof assertion.duration === "number" && Number.isFinite(assertion.duration)
            ? Math.max(0, Math.round(assertion.duration))
            : null,
        message:
          status === "failed"
            ? boundMessage(assertion.failureMessages?.[0]) ??
              "The runner reported this test as failed without a message."
            : status === "errored"
              ? `The runner reported an unrecognized status "${assertion.status}".`
              : null,
      });
    }
  }

  results.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );

  return { results, notes };
}
