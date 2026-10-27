import { z } from "zod";

import { impactReportSchema } from "./impact.js";

/**
 * Execution report schema version. Like the scan report and the diff, this is
 * stored evidence: a reader must reject a version it does not understand.
 */
export const EXECUTION_SCHEMA_VERSION = 1;

/**
 * Outcome of one check. This is deliberately separate from a finding's evidence
 * status (`suspected` / `reproduced` / `unable_to_verify`): a test that errored
 * during collection produced no evidence either way, and must never be folded
 * into `passed`.
 *
 * - `timed_out` — the supervisor killed the run at the deadline.
 * - `errored` — the runner crashed, reported no result, or could not collect.
 * - `unsupported` — the requested check cannot run in this configuration.
 * - `cancelled` — the caller aborted the run.
 */
export const checkStatusSchema = z.enum([
  "passed",
  "failed",
  "skipped",
  "timed_out",
  "errored",
  "cancelled",
  "unsupported",
]);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

/**
 * One normalized test outcome.
 *
 * `id` is a fingerprint over the file and the full test name, so the same test
 * keeps its identity across runs even when line numbers move. It is not a
 * promise that the test asserts the same thing.
 */
export const testResultSchema = z.object({
  id: z.string().regex(/^t_[0-9a-f]{16}$/),
  file: z.string().min(1),
  name: z.string(),
  status: checkStatusSchema,
  durationMs: z.number().int().nonnegative().nullable(),
  /** Bounded runner message for a non-passing check; null when none was reported. */
  message: z.string().nullable(),
});
export type TestResult = z.infer<typeof testResultSchema>;

/**
 * Where the checks actually ran. `source-copy` is a fresh copy of the analyzed
 * tree in the OS temp directory; `none` means the checkout itself, which is only
 * allowed when the caller asks for it explicitly.
 *
 * `sharedPaths` lists paths the copy shares with the checkout rather than
 * duplicating. Sharing is a practical compromise, not a security boundary, and
 * the limitations list says so.
 */
export const executionIsolationSchema = z.object({
  mode: z.enum(["source-copy", "none"]),
  root: z.string().min(1),
  sharedPaths: z.array(z.string()),
  limitations: z.array(z.string().min(1)).min(1),
});
export type ExecutionIsolation = z.infer<typeof executionIsolationSchema>;

export const executionCountsSchema = z.object({
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  timedOut: z.number().int().nonnegative(),
  errored: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type ExecutionCounts = z.infer<typeof executionCountsSchema>;

/**
 * One supervised runner invocation. A report may contain exactly one of these
 * in this schema version; separate attempts get separate record IDs.
 */
export const executionRecordSchema = z.object({
  id: z.string().regex(/^run_[0-9a-f]{16}$/),
  runner: z.literal("vitest"),
  runnerVersion: z.string().nullable(),
  nodeVersion: z.string().min(1),
  platform: z.string().min(1),
  status: checkStatusSchema,
  /** Null when the process never produced an exit code (killed or never started). */
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  startedAt: z.iso.datetime(),
  /** The exact argv vector, not a shell string. */
  command: z.array(z.string()),
  counts: executionCountsSchema,
  isolation: executionIsolationSchema,
  /** Why the run ended this way. Null only for a clean pass. */
  detail: z.string().nullable(),
});
export type ExecutionRecord = z.infer<typeof executionRecordSchema>;

/**
 * A run report: the change analysis that selected the checks, the supervised
 * execution record, and the normalized per-test results.
 *
 * The impact report is embedded rather than referenced so the evidence says by
 * itself which tests were selected and why, and what was out of scope.
 */
export const testRunReportSchema = z.object({
  schemaVersion: z.literal(EXECUTION_SCHEMA_VERSION),
  generatedAt: z.iso.datetime(),
  root: z.string().min(1),
  impact: impactReportSchema,
  record: executionRecordSchema,
  results: z.array(testResultSchema),
  limitations: z.array(z.string().min(1)).min(1),
});
export type TestRunReport = z.infer<typeof testRunReportSchema>;

/**
 * How a shared fingerprint's pair of results relates. The label comes from the
 * paired statuses, always read from the `after` side's point of view.
 *
 * - A `newly_*` label means the before report has no result for that
 *   fingerprint; it says what the test did the first time it was seen.
 * - `gone` means the before report has a result and the after report does not —
 *   including because the selection changed — and is never evidence of removal.
 */
export const outcomeComparisonSchema = z.enum([
  "newly_failing",
  "still_failing",
  "fixed",
  "newly_passing",
  "still_passing",
  "newly_inconclusive",
  "still_inconclusive",
  "newly_skipped",
  "still_skipped",
  "gone",
]);
export type OutcomeComparison = z.infer<typeof outcomeComparisonSchema>;

export const EXECUTION_COMPARISON_SCHEMA_VERSION = 1;

/** One stored outcome, kept as a status plus its bounded message. */
export const comparedTestSideSchema = z.object({
  status: checkStatusSchema,
  message: z.string().nullable(),
});
export type ComparedTestSide = z.infer<typeof comparedTestSideSchema>;

/**
 * One fingerprint's before/after pair.
 *
 * `identitySuspect` is set when the test file's change classification differs
 * between the two runs' impact reports. The fingerprint is `file + name`, so a
 * fingerprint that survived may still be a different body: an edited test keeps
 * its id. The flag is an honest warning, not a reinterpretation.
 */
export const comparedTestSchema = z.object({
  id: z.string().regex(/^t_[0-9a-f]{16}$/),
  file: z.string().min(1),
  name: z.string(),
  before: comparedTestSideSchema.nullable(),
  after: comparedTestSideSchema.nullable(),
  comparison: outcomeComparisonSchema,
  identitySuspect: z.boolean(),
});
export type ComparedTest = z.infer<typeof comparedTestSchema>;

export const comparisonCountsSchema = z.object({
  newlyFailing: z.number().int().nonnegative(),
  stillFailing: z.number().int().nonnegative(),
  fixed: z.number().int().nonnegative(),
  newlyPassing: z.number().int().nonnegative(),
  stillPassing: z.number().int().nonnegative(),
  newlyInconclusive: z.number().int().nonnegative(),
  stillInconclusive: z.number().int().nonnegative(),
  newlySkipped: z.number().int().nonnegative(),
  stillSkipped: z.number().int().nonnegative(),
  gone: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type ComparisonCounts = z.infer<typeof comparisonCountsSchema>;

/** Who produced a stored report, summarized for the comparison header. */
export const executionContactSchema = z.object({
  root: z.string().min(1),
  generatedAt: z.iso.datetime(),
  runnerVersion: z.string().nullable(),
  nodeVersion: z.string().min(1),
  platform: z.string().min(1),
  status: checkStatusSchema,
});
export type ExecutionContact = z.infer<typeof executionContactSchema>;

/**
 * A before/after comparison of two stored run reports.
 *
 * `comparable: false` does not delete the test mapping: the pairing is still
 * shown, with the reasons it must not be read as evidence. Reasons are empty
 * exactly when `comparable` is true.
 */
export const executionComparisonSchema = z.object({
  schemaVersion: z.literal(EXECUTION_COMPARISON_SCHEMA_VERSION),
  generatedAt: z.iso.datetime(),
  before: executionContactSchema,
  after: executionContactSchema,
  comparable: z.boolean(),
  notComparableReasons: z.array(z.string().min(1)),
  tests: z.array(comparedTestSchema),
  counts: comparisonCountsSchema,
  limitations: z.array(z.string().min(1)).min(1),
});
export type ExecutionComparison = z.infer<typeof executionComparisonSchema>;
