import type { PatchVerificationReport, PatchVerificationVerdict } from "@codecitadel/contracts";

const VERDICT_LABEL: Record<PatchVerificationVerdict, string> = {
  verified: "VERIFIED",
  not_verified: "NOT VERIFIED",
  inconclusive: "INCONCLUSIVE",
  not_applied: "NOT APPLIED",
};

const COMPARISON_LABEL: Record<string, string> = {
  newly_failing: "newly failing",
  still_failing: "still failing",
  fixed: "fixed",
  newly_passing: "newly passing",
  still_passing: "still passing",
  newly_inconclusive: "newly inconclusive",
  still_inconclusive: "still inconclusive",
  newly_skipped: "newly skipped",
  still_skipped: "still skipped",
  gone: "gone",
};

const REQUIREMENT_LABEL: Record<string, string> = {
  met: "MET",
  unmet: "UNMET",
  inconclusive: "INCONCLUSIVE",
  not_accepted: "NOT ACCEPTED",
};

/**
 * Text renderer for a patch verification report. It prints what the report
 * records and computes nothing: every count and verdict already exists in the
 * validated contract.
 */
export function renderPatchVerificationText(report: PatchVerificationReport): string {
  const lines: string[] = [];

  lines.push(`patch verification → ${VERDICT_LABEL[report.verdict]}`);
  lines.push(`  root ${report.root}`);
  lines.push(
    `  patch ${report.patch.digest.slice(0, 21)}… (${report.patch.files} file(s), ` +
      `+${report.patch.addedLines}/-${report.patch.removedLines})`,
  );
  if (report.comparison !== null) {
    lines.push(
      `  runs ${report.comparison.before.status} → ${report.comparison.after.status}` +
        (report.comparison.comparable ? "" : " (not comparable)"),
    );
  }
  if (report.after !== null) {
    const { record } = report.after;
    lines.push(
      `  after ${record.runner}${record.runnerVersion ? ` ${record.runnerVersion}` : ""} ` +
        `on node ${record.nodeVersion} (${record.platform}), isolation ${record.isolation.mode}, ` +
        `${record.durationMs}ms`,
    );
  }
  lines.push("", `reason: ${report.reason}`);

  lines.push("", `patch files (${report.inspection.files.length})`);
  for (const file of report.inspection.files) {
    lines.push(
      `  ${file.status.padEnd(9)} ${file.kind.padEnd(19)} ${file.path} ` +
        `(+${file.addedLines}/-${file.removedLines})`,
    );
  }

  if (report.inspection.signals.length > 0) {
    lines.push("", `signals (${report.inspection.signals.length})`);
    for (const signal of report.inspection.signals) {
      const where = signal.line === null ? fileLine(signal.file) : `${signal.file}:${signal.line}`;
      lines.push(`  ${signal.severity.padEnd(9)} ${signal.kind.padEnd(21)} ${where}`);
      lines.push(`    ${signal.detail}`);
    }
  }

  if (report.comparison !== null) {
    const counts = report.comparison.counts;
    lines.push(
      "",
      `comparison: ${counts.fixed} fixed, ${counts.newlyFailing} newly failing, ` +
        `${counts.stillFailing} still failing, ${counts.newlyPassing} newly passing, ` +
        `${counts.stillPassing} still passing, ${counts.newlyInconclusive} newly inconclusive, ` +
        `${counts.newlySkipped} newly skipped, ${counts.gone} gone`,
    );
    if (!report.comparison.comparable) {
      for (const reason of report.comparison.notComparableReasons) {
        lines.push(`  not comparable: ${reason}`);
      }
    }
    for (const test of report.comparison.tests) {
      if (test.comparison === "still_passing") {
        continue;
      }
      const label = COMPARISON_LABEL[test.comparison] ?? test.comparison;
      lines.push(`  ${label.padEnd(19)} ${test.file} › ${test.name}`);
      if (test.identitySuspect) {
        lines.push("    identity suspect: the file's change classification differs between the runs");
      }
      if (test.after?.message != null && test.after.status !== "passed") {
        lines.push(`    ${test.after.message}`);
      }
    }
  }

  if (report.requirements !== null) {
    const { counts } = report.requirements;
    lines.push(
      "",
      `requirements: ${counts.met} met, ${counts.unmet} unmet, ` +
        `${counts.inconclusive} inconclusive, ${counts.notAccepted} not accepted`,
    );
    for (const requirement of report.requirements.requirements) {
      const label = REQUIREMENT_LABEL[requirement.verdict] ?? requirement.verdict;
      lines.push(`  ${label.padEnd(12)} ${requirement.id}`);
      for (const check of requirement.checks) {
        lines.push(`    ${check.id}: ${check.outcome}${check.message ? ` — ${check.message}` : ""}`);
      }
    }
  }

  if (report.requirementRegressions.length > 0) {
    lines.push("", `requirements that stopped being met: ${report.requirementRegressions.join(", ")}`);
  }

  lines.push("", "limitations");
  for (const limitation of report.limitations) {
    lines.push(`  - ${limitation}`);
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

/** A signal about the file as a whole has no line number to point at. */
function fileLine(file: string): string {
  return `${file} (whole file)`;
}
