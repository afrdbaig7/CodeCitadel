import {
  EXECUTION_COMPARISON_SCHEMA_VERSION,
  type ChangedFile,
  type CheckStatus,
  type ComparedTest,
  type ComparisonCounts,
  type ExecutionComparison,
  type ExecutionContact,
  type OutcomeComparison,
  type TestRunReport,
} from "@codecitadel/contracts";

/**
 * Pure before/after comparison of two stored run reports. Like the snapshot
 * diff, it reads two validated reports and produces a versioned record; it
 * knows nothing about files or processes and never runs anything.
 *
 * The pairing key is the `t_…` fingerprint (file + full test name), not line
 * numbers: results line up across runs even when tests move inside a file.
 */
const INCONCLUSIVE: ReadonlySet<CheckStatus> = new Set<CheckStatus>([
  "errored",
  "timed_out",
  "cancelled",
  "unsupported",
]);

interface Side {
  status: CheckStatus;
  message: string | null;
}

function sideOf(status: CheckStatus, message: string | null): Side {
  return { status, message };
}

function labelPair(before: Side | null, after: Side): OutcomeComparison {
  if (after.status === "failed") {
    return before !== null && before.status === "failed" ? "still_failing" : "newly_failing";
  }
  if (after.status === "passed") {
    if (before === null) {
      return "newly_passing";
    }
    return before.status === "failed" ? "fixed" : before.status === "passed" ? "still_passing" : "newly_passing";
  }
  if (INCONCLUSIVE.has(after.status)) {
    return before !== null && before.status === after.status ? "still_inconclusive" : "newly_inconclusive";
  }
  // skipped — and unsupported would already have been handled above.
  return before !== null && before.status === "skipped" ? "still_skipped" : "newly_skipped";
}

function contactOf(report: TestRunReport): ExecutionContact {
  return {
    root: report.root,
    generatedAt: report.generatedAt,
    runnerVersion: report.record.runnerVersion,
    nodeVersion: report.record.nodeVersion,
    platform: report.record.platform,
    status: report.record.status,
  };
}

function changeKinds(report: TestRunReport): Map<string, ChangedFile["change"]> {
  return new Map(report.impact.changed.map((entry) => [entry.path, entry.change]));
}

/**
 * A fingerprint survives, but its body may not have: the id does not capture
 * the test text. The best the stored evidence allows is to compare how each
 * run classified that file relative to its own base snapshot. Equal
 * classifications prove nothing (two edits can happen between the same pair
 * of classifications), but differing ones are a definite warning.
 */
function identitySuspects(
  before: TestRunReport,
  after: TestRunReport,
): (path: string) => boolean {
  const beforeKinds = changeKinds(before);
  const afterKinds = changeKinds(after);

  return (file: string): boolean => {
    const beforeKind = beforeKinds.get(file);
    const afterKind = afterKinds.get(file);
    return beforeKind !== afterKind;
  };
}

const SELECTED_FILES_NOTE =
  "The two runs selected different test files, so their per-test comparison is not a controlled change experiment.";

function comparabilityReasons(
  before: TestRunReport,
  after: TestRunReport,
): string[] {
  const reasons: string[] = [];

  if (before.root !== after.root) {
    reasons.push(
      `The runs analyzed different roots (${before.root} and ${after.root}); results are relative to their own root.`,
    );
  }
  if (before.record.platform !== after.record.platform) {
    reasons.push(
      `The runs reported different platforms (${before.record.platform} and ${after.record.platform}).`,
    );
  }
  if (before.record.nodeVersion !== after.record.nodeVersion) {
    reasons.push(
      `The runs reported different Node versions (${before.record.nodeVersion} and ${after.record.nodeVersion}).`,
    );
  }
  if (
    before.record.runnerVersion !== null &&
    after.record.runnerVersion !== null &&
    before.record.runnerVersion !== after.record.runnerVersion
  ) {
    reasons.push(
      `The runs used different runner versions (${before.record.runnerVersion} and ${after.record.runnerVersion}).`,
    );
  }
  if (before.record.isolation.mode !== after.record.isolation.mode) {
    reasons.push(
      `The runs used different isolation modes (${before.record.isolation.mode} and ${after.record.isolation.mode}); a run in the checkout is not the same experiment as one in a copy.`,
    );
  }

  const selected = (report: TestRunReport): string[] =>
    report.impact.tests.selected.map((entry) => entry.path).sort((l, r) => l.localeCompare(r));
  const beforeSelected = selected(before);
  const afterSelected = selected(after);
  if (
    beforeSelected.length !== afterSelected.length ||
    beforeSelected.some((entry, index) => entry !== afterSelected[index])
  ) {
    reasons.push(SELECTED_FILES_NOTE);
  }

  const beforeChanged = changeKinds(before);
  const afterChanged = changeKinds(after);
  const paths = [...new Set([...beforeChanged.keys(), ...afterChanged.keys()])].sort((l, r) =>
    l.localeCompare(r),
  );
  const differing = paths.filter((entry) => beforeChanged.get(entry) !== afterChanged.get(entry));
  if (differing.length > 0) {
    reasons.push(
      `The change classification differs between the two runs for: ${differing.join(", ")}. ` +
        "The compared trees are not the same experiment.",
    );
  }

  return reasons;
}

function countsFor(tests: readonly ComparedTest[]): ComparisonCounts {
  const counts: ComparisonCounts = {
    newlyFailing: 0,
    stillFailing: 0,
    fixed: 0,
    newlyPassing: 0,
    stillPassing: 0,
    newlyInconclusive: 0,
    stillInconclusive: 0,
    newlySkipped: 0,
    stillSkipped: 0,
    gone: 0,
    total: tests.length,
  };
  for (const test of tests) {
    switch (test.comparison) {
      case "newly_failing":
        counts.newlyFailing += 1;
        break;
      case "still_failing":
        counts.stillFailing += 1;
        break;
      case "fixed":
        counts.fixed += 1;
        break;
      case "newly_passing":
        counts.newlyPassing += 1;
        break;
      case "still_passing":
        counts.stillPassing += 1;
        break;
      case "newly_inconclusive":
        counts.newlyInconclusive += 1;
        break;
      case "still_inconclusive":
        counts.stillInconclusive += 1;
        break;
      case "newly_skipped":
        counts.newlySkipped += 1;
        break;
      case "still_skipped":
        counts.stillSkipped += 1;
        break;
      case "gone":
        counts.gone += 1;
        break;
    }
  }
  return counts;
}

function limitationsFor(
  before: TestRunReport,
  after: TestRunReport,
  reasons: readonly string[],
): string[] {
  const limitations: string[] = [];

  limitations.push(
    "A compared fingerprint means the same file and test name resolved the same way. " +
      "The fingerprint does not capture the test body: a test whose assertions were edited keeps its id, " +
      "and identitySuspect marks tests from files whose change classification differs between the two runs.",
  );
  if (
    before.record.runnerVersion === null ||
    after.record.runnerVersion === null
  ) {
    limitations.push(
      "The runner version is unknown in at least one report, so a version mismatch could not be ruled out.",
    );
  }
  limitations.push(
    "A test counted as gone either ran in one report and not the other or was never reported; " +
      "absence from a report is not evidence of removal.",
  );
  limitations.push(
    "Per-test statuses come from the runner's normalized report. Messages are bounded first lines; " +
      "the comparison carries no assertion detail beyond them.",
  );
  if (reasons.length > 0) {
    limitations.push(
      "comparable is false for this pair, so the per-test pairing must not be used as verification evidence.",
    );
  }

  return limitations;
}

export interface CompareExecutionInput {
  before: TestRunReport;
  after: TestRunReport;
  generatedAt?: Date;
}

/**
 * Pairs the two reports' results by fingerprint and labels every pair. Runs
 * with mismatched environment, selection, or change classification get
 * `comparable: false` with the reasons spelled out; the pairing itself is
 * still produced, because "why not comparable" is easier to judge in context.
 */
export function compareExecutionReports(input: CompareExecutionInput): ExecutionComparison {
  const { before, after } = input;

  const byId = <T extends { id: string }>(results: readonly T[]): Map<string, T> =>
    new Map(results.map((result) => [result.id, result]));
  const beforeById = byId(before.results);
  const afterById = byId(after.results);

  const suspect = identitySuspects(before, after);

  const tests: ComparedTest[] = [];
  for (const [id, afterResult] of afterById) {
    const beforeResult = beforeById.get(id);
    const beforeSide = beforeResult === undefined ? null : sideOf(beforeResult.status, beforeResult.message);
    tests.push({
      id,
      file: afterResult.file,
      name: afterResult.name,
      before: beforeSide,
      after: sideOf(afterResult.status, afterResult.message),
      comparison: labelPair(beforeSide, sideOf(afterResult.status, afterResult.message)),
      identitySuspect: suspect(afterResult.file),
    });
  }
  for (const [id, beforeResult] of beforeById) {
    if (!afterById.has(id)) {
      tests.push({
        id,
        file: beforeResult.file,
        name: beforeResult.name,
        before: sideOf(beforeResult.status, beforeResult.message),
        after: null,
        comparison: "gone",
        identitySuspect: suspect(beforeResult.file),
      });
    }
  }

  tests.sort(
    (left, right) =>
      left.comparison.localeCompare(right.comparison) ||
      left.file.localeCompare(right.file) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );

  const reasons = comparabilityReasons(before, after);

  return {
    schemaVersion: EXECUTION_COMPARISON_SCHEMA_VERSION,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    before: contactOf(before),
    after: contactOf(after),
    comparable: reasons.length === 0,
    notComparableReasons: reasons,
    tests,
    counts: countsFor(tests),
    limitations: limitationsFor(before, after, reasons),
  };
}
