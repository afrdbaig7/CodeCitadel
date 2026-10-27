import {
  EXIT_CODES,
  type ExecutionComparison,
  type ExitCode,
} from "@codecitadel/contracts";
import { compareExecutionReports } from "@codecitadel/core";

import { UsageError } from "../errors.js";
import { renderComparisonText } from "../render.js";
import { readRunReport } from "../run-report-file.js";

export interface CompareCommandOptions {
  before?: string;
  after?: string;
  format?: string;
}

const FORMATS = ["text", "json"] as const;
type Format = (typeof FORMATS)[number];

function parseFormat(value: string | undefined): Format {
  const format = value ?? "text";
  if (!FORMATS.includes(format as Format)) {
    throw new UsageError(
      `--format must be one of ${FORMATS.join(", ")} for compare, received "${format}".`,
    );
  }
  return format as Format;
}

/**
 * Compares two stored execution reports by test fingerprint.
 *
 * This command never executes anything and never touches a repository: both
 * inputs are files written earlier by `codecitadel run --out`. That is the
 * point — the verdict attaches to stored evidence, not to a fresh invocation
 * that could hide what the second run did.
 *
 * Exit codes: 0 when the pair is comparable and nothing fails at the after
 * side, 1 when a test is failing after the paired experiment (newly or still),
 * and 2 when the pair is not comparable or evidence was lost (inconclusive or
 * newly skipped).
 */
export async function runCompareCommand(options: CompareCommandOptions): Promise<ExitCode> {
  if (!options.before || !options.after) {
    throw new UsageError("compare requires --before <report.json> and --after <report.json>.");
  }

  const format = parseFormat(options.format);
  const before = await readRunReport(options.before);
  const after = await readRunReport(options.after);

  const comparison: ExecutionComparison = compareExecutionReports({ before, after });
  const rendered =
    format === "json" ? `${JSON.stringify(comparison, null, 2)}\n` : renderComparisonText(comparison);
  process.stdout.write(rendered);

  const { counts, comparable, notComparableReasons } = comparison;
  if (!comparable) {
    for (const reason of notComparableReasons) {
      process.stderr.write(`not comparable: ${reason}\n`);
    }
    return EXIT_CODES.error;
  }
  process.stderr.write(
    `compared: ${comparison.tests.length} fingerprint(s) — ` +
      `${counts.newlyFailing} newly failing, ${counts.stillFailing} still failing, ` +
      `${counts.fixed} fixed, ${counts.newlyInconclusive} newly inconclusive, ` +
      `${counts.stillInconclusive} still inconclusive, ${counts.newlySkipped} newly skipped, ` +
      `${counts.gone} gone\n`,
  );

  if (counts.newlyFailing > 0 || counts.stillFailing > 0) {
    return EXIT_CODES.policyBreach;
  }
  if (counts.newlyInconclusive > 0 || counts.stillInconclusive > 0 || counts.newlySkipped > 0) {
    // Evidence was lost after the change: neither a pass nor a failure.
    return EXIT_CODES.error;
  }
  return EXIT_CODES.ok;
}
