import type {
  CheckStatus,
  CodeCitadelReport,
  ExecutionComparison,
  FileChange,
  ImpactChainEntry,
  ImpactReport,
  OutcomeComparison,
  SnapshotDiff,
  TestRunReport,
} from "@codecitadel/contracts";

/**
 * Markdown renderer. It reads one report contract and never recomputes
 * analysis: every number here comes from the report.
 *
 * Markdown is generated as text, but repository paths and snippets are
 * attacker-influenced content, so they are escaped for table cells and fenced
 * with a fixed fence length that the snippet cannot terminate.
 */
function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function fenceFor(snippet: string): string {
  let fence = "```";
  while (snippet.includes(fence)) {
    fence += "`";
  }
  return fence;
}

export function renderMarkdown(report: CodeCitadelReport): string {
  const lines: string[] = [];
  const { scope, summary } = report;

  lines.push("# CodeCitadel scan report", "");
  lines.push(
    `Scanned \`${scope.root}\` with CodeCitadel ${report.tool.version} ` +
      `(scanner ${report.tool.scannerVersion}, protocol ${report.tool.protocol.major}.${report.tool.protocol.minor}).`,
    "",
  );

  lines.push("## Scope", "");
  lines.push(`- Files scanned: ${scope.filesScanned}`);
  lines.push(`- Files skipped: ${scope.filesSkipped}`);
  lines.push(`- Bytes read: ${scope.bytesRead}`);
  lines.push(`- Duration: ${scope.durationMs} ms`);
  lines.push(`- Truncated: ${scope.truncated ? "yes" : "no"}`);
  lines.push("");

  lines.push("## Findings", "");
  lines.push(
    `${summary.findings} finding(s): ` +
      `${summary.bySeverity.critical} critical, ${summary.bySeverity.high} high, ` +
      `${summary.bySeverity.medium} medium, ${summary.bySeverity.low} low, ` +
      `${summary.bySeverity.info} info.`,
    "",
  );

  if (report.findings.length === 0) {
    lines.push("No findings matched the enabled rules.", "");
  }

  for (const finding of report.findings) {
    const cell = (value: string) => escapeCell(value);
    lines.push(`### ${finding.severity.toUpperCase()}: ${finding.ruleTitle}`);
    lines.push("");
    lines.push(`- Rule: \`${cell(finding.ruleId)}\` v${cell(finding.ruleVersion)}`);
    lines.push(
      `- Location: \`${cell(finding.location.path)}:${finding.location.startLine}:${finding.location.startColumn}\``,
    );
    lines.push(`- Evidence: ${finding.evidenceStatus} (confidence: ${finding.confidence})`);
    lines.push(`- Fingerprint: \`${finding.id}\``);
    lines.push("");
    if (finding.location.snippet) {
      const fence = fenceFor(finding.location.snippet);
      lines.push(`${fence}text`);
      lines.push(finding.location.snippet);
      lines.push(fence);
      if (finding.location.snippetRedacted) {
        lines.push("", "_The matched text was redacted; only surrounding context is shown._");
      }
      lines.push("");
    }
    lines.push(finding.explanation, "");
    lines.push(`**Remediation.** ${finding.remediation}`, "");
  }

  lines.push("## Limitations", "");
  for (const limitation of scope.limitations) {
    lines.push(`- ${limitation}`);
  }
  lines.push("");
  lines.push(`_Report schema ${report.schemaVersion}. Generated ${report.generatedAt}._`);
  return `${lines.join("\n")}\n`;
}

const DIFF_FILE_SECTIONS: ReadonlyArray<{ key: keyof SnapshotDiff["files"]; marker: string }> = [
  { key: "added", marker: "+" },
  { key: "modified", marker: "~" },
  { key: "removed", marker: "-" },
  { key: "unverified", marker: "?" },
];

function fileEntries(diff: SnapshotDiff, key: keyof SnapshotDiff["files"]): FileChange[] {
  const value = diff.files[key];
  return Array.isArray(value) ? value : [];
}

/**
 * Plain-text diff. Every line states what was observed; nothing is summarised
 * into a verdict such as "safe to merge".
 */
export function renderDiffText(diff: SnapshotDiff): string {
  const { base, head, files, findings, rules, options } = diff;
  const lines: string[] = [];

  lines.push(
    `base ${base.generatedAt} (${base.files} file(s), ${base.findings} finding(s)` +
      `${base.truncated ? ", truncated" : ""})`,
  );
  lines.push(
    `head ${head.generatedAt} (${head.files} file(s), ${head.findings} finding(s)` +
      `${head.truncated ? ", truncated" : ""})`,
  );
  lines.push("");
  lines.push(
    `files: ${files.unchanged} unchanged, +${files.added.length} added, ` +
      `~${files.modified.length} modified, -${files.removed.length} removed, ` +
      `?${files.unverified.length} unverified` +
      (files.stillUnverified > 0 ? `, ${files.stillUnverified} never readable` : ""),
  );
  lines.push(
    rules.changed
      ? `rules: changed (${[
          rules.added.length > 0 ? `added ${rules.added.join(", ")}` : "",
          rules.removed.length > 0 ? `removed ${rules.removed.join(", ")}` : "",
          rules.versionChanged.length > 0 ? `new version ${rules.versionChanged.join(", ")}` : "",
        ]
          .filter((part) => part.length > 0)
          .join("; ")})`
      : "rules: unchanged",
  );
  if (options.changed) {
    lines.push(`scope: changed (${options.differences.join("; ")})`);
  }
  lines.push(
    `findings: ${findings.introduced.length} introduced, ${findings.resolved.length} resolved, ` +
      `${findings.unverified.length} unverified, ${findings.carriedOver} carried over`,
  );

  const findingSection = (
    title: string,
    entries: SnapshotDiff["findings"]["introduced"],
    marker: string,
  ) => {
    if (entries.length === 0) {
      return;
    }
    lines.push("", title);
    for (const entry of entries) {
      lines.push(
        `  ${marker} ${entry.severity.padEnd(8)} ${entry.ruleId.padEnd(36)} ` +
          `${entry.path}:${entry.startLine}`,
      );
    }
  };

  findingSection("introduced findings", findings.introduced, "+");
  findingSection("resolved findings", findings.resolved, "-");
  findingSection("findings that could not be re-checked", findings.unverified, "?");

  for (const section of DIFF_FILE_SECTIONS) {
    const entries = fileEntries(diff, section.key);
    if (entries.length === 0) {
      continue;
    }
    lines.push("", `${section.key} files`);
    for (const entry of entries) {
      const note = entry.headSkipped ? ` (${entry.headSkipped})` : "";
      lines.push(`  ${section.marker} ${entry.path}${note}`);
    }
  }

  lines.push("", "limitations");
  for (const limitation of diff.limitations) {
    lines.push(`  - ${limitation}`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Plain-text impact report. The chain is printed as "test → … → change" because
 * that is the direction a reader needs: from the thing they would run to the
 * thing that moved.
 */
export function renderImpactText(report: ImpactReport): string {
  const lines: string[] = [];
  const changedLabel = report.changed.map((entry) => `${entry.change} ${entry.path}`);

  lines.push(`base ${report.base.generatedAt} (${report.base.root})`);
  lines.push(
    changedLabel.length > 0
      ? `changed ${changedLabel.length} file(s): ${changedLabel.join(", ")}`
      : "changed: none",
  );
  lines.push(
    `graph: ${report.graph.modules} module(s), ${report.graph.edges} edge(s), ` +
      `${report.graph.testFiles} test file(s); ${report.graph.externalImports} external import(s), ` +
      `${report.graph.outsideScope} outside scope, ${report.graph.unresolved.length} unresolved`,
  );

  lines.push("");
  if (report.tests.selected.length === 0) {
    lines.push("selected tests: none");
  } else {
    lines.push(`selected tests (${report.tests.selected.length}):`);
    for (const test of report.tests.selected) {
      lines.push(`  ${formatChain(test.chain)}  [${test.depth} hop(s)]`);
    }
  }
  lines.push(`not selected: ${report.tests.notSelected} test file(s)`);

  if (report.impacted.length > report.tests.selected.length) {
    const selectedPaths = new Set(report.tests.selected.map((entry) => entry.path));
    const nonTest = report.impacted.filter((entry) => !selectedPaths.has(entry.path));
    if (nonTest.length > 0) {
      lines.push("", `other impacted files (${nonTest.length}):`);
      for (const entry of nonTest.slice(0, 20)) {
        lines.push(`  ${entry.path}  [${entry.depth} hop(s)]`);
      }
      if (nonTest.length > 20) {
        lines.push(`  … ${nonTest.length - 20} more`);
      }
    }
  }

  if (!report.complete) {
    lines.push("", "incomplete:");
    for (const reason of report.incompleteReasons) {
      lines.push(`  - ${reason}`);
    }
  }

  lines.push("", "limitations");
  for (const limitation of report.limitations) {
    lines.push(`  - ${limitation}`);
  }

  return `${lines.join("\n")}\n`;
}

function formatChain(chain: readonly ImpactChainEntry[]): string {
  return chain.map((entry) => entry.path).join(" → ");
}

const STATUS_LABEL: Record<CheckStatus, string> = {
  passed: "PASSED",
  failed: "FAILED",
  skipped: "SKIPPED",
  timed_out: "TIMED OUT",
  errored: "ERRORED",
  cancelled: "CANCELLED",
  unsupported: "UNSUPPORTED",
};

const COMPARISON_LABEL: Record<OutcomeComparison, string> = {
  newly_failing: "NEWLY FAILING",
  still_failing: "STILL FAILING",
  fixed: "FIXED",
  newly_passing: "NEWLY PASSING",
  still_passing: "STILL PASSING",
  newly_inconclusive: "INCONCLUSIVE",
  still_inconclusive: "INCONCLUSIVE",
  newly_skipped: "SKIPPED",
  still_skipped: "SKIPPED",
  gone: "NOT RUN",
};

/**
 * Plain-text execution report. It states the selection, where the run happened,
 * and one line per observed result. Nothing here turns "no result" into a pass:
 * errored, timed out, cancelled, and unsupported are printed as their own
 * outcomes.
 */
export function renderRunText(report: TestRunReport): string {
  const { record, impact, results } = report;
  const lines: string[] = [];

  lines.push(`run ${record.id} → ${record.status}`);
  lines.push(
    `  ${record.runner}${record.runnerVersion ? ` ${record.runnerVersion}` : " (version unknown)"} ` +
      `on node ${record.nodeVersion} (${record.platform})`,
  );
  lines.push(`  root ${report.root}`);
  lines.push(
    `  isolation ${record.isolation.mode}` +
      (record.isolation.sharedPaths.length > 0
        ? ` (linked from the checkout: ${record.isolation.sharedPaths.join(", ")})`
        : ""),
  );
  lines.push(
    `  duration ${record.durationMs}ms` +
      (record.exitCode !== null ? `, runner exit code ${record.exitCode}` : ", no exit code"),
  );

  lines.push("");
  lines.push(
    `changed ${impact.changed.length} file(s); selected ${impact.tests.selected.length} of ` +
      `${impact.graph.testFiles} test file(s)` +
      (impact.complete ? "" : " (graph incomplete: selection is a lower bound)"),
  );
  for (const entry of impact.changed) {
    lines.push(`  ${entry.change} ${entry.path}`);
  }
  if (impact.tests.selected.length > 0) {
    lines.push("", "selected:");
    for (const entry of impact.tests.selected) {
      lines.push(`  ${formatChain(entry.chain)}  [${entry.depth} hop(s)]`);
    }
  }

  lines.push("");
  lines.push(
    `results: ${record.counts.passed} passed, ${record.counts.failed} failed, ` +
      `${record.counts.skipped} skipped, ${record.counts.errored} errored, ` +
      `${record.counts.timedOut} timed out, ${record.counts.cancelled} cancelled, ` +
      `${record.counts.unsupported} unsupported`,
  );
  for (const result of results) {
    const duration = result.durationMs === null ? "" : `  (${result.durationMs}ms)`;
    lines.push(`  ${STATUS_LABEL[result.status].padEnd(11)} ${result.file} › ${result.name}${duration}`);
    if (result.message !== null && result.status !== "passed") {
      lines.push(`    ${result.message}`);
    }
  }

  if (record.detail !== null) {
    lines.push("", `detail: ${record.detail}`);
  }

  lines.push("", "limitations");
  for (const limitation of report.limitations) {
    lines.push(`  - ${limitation}`);
  }
  lines.push("");
  lines.push(`_Execution schema ${report.schemaVersion}. Generated ${report.generatedAt}._`);
  return `${lines.join("\n")}\n`;
}

/**
 * Plain-text before/after comparison. It pairs stored reports by fingerprint
 * and prints the verdict, one line per outcome change, and the reasons the
 * pair must not be read as evidence when it is not comparable. Every line is
 * derived from the stored evidence; nothing is inferred from fresh state.
 */
export function renderComparisonText(comparison: ExecutionComparison): string {
  const { before, after, comparable, notComparableReasons, tests, counts } = comparison;
  const lines: string[] = [];

  lines.push(`compare → ${comparable ? "comparable" : "NOT COMPARABLE"}`);
  lines.push(
    `  before run ${comparison.before.generatedAt} (${before.status}) — vitest ` +
      `${before.runnerVersion ?? "(version unknown)"} on node ${before.nodeVersion} (${before.platform}), root ${before.root}`,
  );
  lines.push(
    `  after  ${after.generatedAt} (${after.status}) — vitest ` +
      `${after.runnerVersion ?? "(version unknown)"} on node ${after.nodeVersion} (${after.platform}), root ${after.root}`,
  );

  if (!comparable) {
    lines.push("", "reasons the pair must not be read as evidence:");
    for (const reason of notComparableReasons) {
      lines.push(`  - ${reason}`);
    }
  }

  lines.push("");
  lines.push(
    `outcome changes: ${counts.newlyFailing} newly failing, ${counts.stillFailing} still failing, ` +
      `${counts.fixed} fixed, ${counts.newlyPassing} newly passing, ${counts.stillPassing} still passing, ` +
      `${counts.newlyInconclusive} newly inconclusive, ${counts.stillInconclusive} still inconclusive, ` +
      `${counts.newlySkipped} newly skipped, ${counts.stillSkipped} still skipped, ` +
      `${counts.gone} gone, out of ${counts.total}`,
  );

  const CHANGES_WITH_MESSAGE: readonly OutcomeComparison[] = [
    "newly_failing",
    "still_failing",
    "fixed",
    "newly_inconclusive",
    "still_inconclusive",
    "newly_skipped",
  ];
  const notable = tests.filter((test) => test.comparison !== "still_passing" && test.comparison !== "still_skipped");
  if (notable.length > 0) {
    lines.push("");
    for (const test of notable) {
      const suspect = test.identitySuspect ? "  [identity suspect]" : "";
      lines.push(`  ${COMPARISON_LABEL[test.comparison].padEnd(14)} ${test.file} › ${test.name}${suspect}`);
      if (test.before !== null && CHANGES_WITH_MESSAGE.includes(test.comparison) && test.before.message !== null) {
        lines.push(`    before: ${test.before.message}`);
      }
      if (test.after !== null && CHANGES_WITH_MESSAGE.includes(test.comparison) && test.after.message !== null) {
        lines.push(`    after:  ${test.after.message}`);
      }
    }
  } else {
    lines.push("", "no outcome changed between the two reports.");
  }

  lines.push("", "limitations");
  for (const limitation of comparison.limitations) {
    lines.push(`  - ${limitation}`);
  }
  lines.push("");
  lines.push(`_Execution comparison schema ${comparison.schemaVersion}. Generated ${comparison.generatedAt}._`);
  return `${lines.join("\n")}\n`;
}

/** Markdown diff for comments and CI summaries. Same data, different layout. */
export function renderDiffMarkdown(diff: SnapshotDiff): string {
  const { base, head, files, findings, rules, options } = diff;
  const lines: string[] = [];

  lines.push("# CodeCitadel change report", "");
  lines.push(`- Base: \`${escapeCell(base.root)}\` at ${base.generatedAt}`);
  lines.push(`- Head: \`${escapeCell(head.root)}\` at ${head.generatedAt}`);
  lines.push("");

  lines.push("## Files", "");
  lines.push("| Change | Count |", "| --- | --- |");
  lines.push(`| unchanged | ${files.unchanged} |`);
  lines.push(`| added | ${files.added.length} |`);
  lines.push(`| modified | ${files.modified.length} |`);
  lines.push(`| removed | ${files.removed.length} |`);
  lines.push(`| unverified | ${files.unverified.length} |`);
  lines.push(`| never readable | ${files.stillUnverified} |`);
  lines.push("");

  const listSection = (title: string, entries: FileChange[], note: string) => {
    if (entries.length === 0) {
      return;
    }
    lines.push(`### ${title}`, "");
    for (const entry of entries) {
      lines.push(`- \`${escapeCell(entry.path)}\`${entry.headSkipped ? ` (${entry.headSkipped})` : ""}`);
    }
    lines.push("", note, "");
  };

  listSection("Added", files.added, "Verified now; not verified in the base snapshot.");
  listSection("Modified", files.modified, "Content digests differ between the two snapshots.");
  listSection("Removed", files.removed, "Verified in the base and absent from the head scan.");
  listSection(
    "Unverified",
    files.unverified,
    "Verified in the base but unreadable or unanalyzed now; this is not \"unchanged\".",
  );

  lines.push("## Findings", "");
  lines.push(
    `${findings.introduced.length} introduced, ${findings.resolved.length} resolved, ` +
      `${findings.unverified.length} could not be re-checked, ${findings.carriedOver} carried over.`,
    "",
  );

  const findingTable = (title: string, entries: SnapshotDiff["findings"]["introduced"]) => {
    if (entries.length === 0) {
      return;
    }
    lines.push(`### ${title}`, "");
    lines.push("| Severity | Rule | Location |", "| --- | --- | --- |");
    for (const entry of entries) {
      lines.push(
        `| ${entry.severity} | \`${escapeCell(entry.ruleId)}\` | ` +
          `\`${escapeCell(entry.path)}:${entry.startLine}\` |`,
      );
    }
    lines.push("");
  };

  findingTable("Introduced", findings.introduced);
  findingTable("Resolved", findings.resolved);
  findingTable("Could not be re-checked (not resolved)", findings.unverified);

  lines.push("## Scan configuration", "");
  lines.push(
    rules.changed
      ? `Rules changed: added ${rules.added.join(", ") || "none"}; removed ` +
          `${rules.removed.join(", ") || "none"}; new versions ${rules.versionChanged.join(", ") || "none"}.`
      : "Rules unchanged.",
  );
  if (options.changed) {
    lines.push("", `Coverage options changed: ${options.differences.map((d) => `\`${escapeCell(d)}\``).join(", ")}.`);
  }
  lines.push("");

  lines.push("## Limitations", "");
  for (const limitation of diff.limitations) {
    lines.push(`- ${limitation}`);
  }
  lines.push("");
  lines.push(`_Diff schema ${diff.schemaVersion}._`);
  return `${lines.join("\n")}\n`;
}
