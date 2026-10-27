import type {
  ReproductionExport,
  ReproductionReport,
  ReproductionVerdict,
} from "@codecitadel/contracts";

const VERDICT_LABEL: Record<ReproductionVerdict, string> = {
  reproduced: "REPRODUCED",
  not_reproduced: "NOT REPRODUCED",
  inconclusive: "INCONCLUSIVE",
  not_accepted: "NOT ACCEPTED",
};

const REQUIREMENT_LABEL: Record<string, string> = {
  current: "accepted as written",
  stale: "acceptance is stale",
  missing: "no acceptance",
};

/**
 * Text renderer for a reproduction report. It prints the record and computes
 * nothing: the verdict, the counts, and the reason all come from the validated
 * contract.
 */
export function renderReproductionText(report: ReproductionReport): string {
  const lines: string[] = [];

  lines.push(`reproduction → ${VERDICT_LABEL[report.verdict]}`);
  lines.push(`  root ${report.root}`);
  lines.push(`  ${report.reproduction.id}: ${report.reproduction.statement}`);
  lines.push(`  provenance ${report.reproduction.provenance}`);
  if (report.requirement !== null) {
    lines.push(
      `  requirement ${report.requirement.id} (${report.requirement.state}, ` +
        `${REQUIREMENT_LABEL[report.requirement.acceptance] ?? report.requirement.acceptance})`,
    );
  }
  lines.push(
    `  check ${report.check.file} › ${report.check.test} ` +
      `(${report.check.fingerprint}, ${report.check.bytes} bytes, ${report.check.digest.slice(0, 21)}…)`,
  );

  if (report.record !== null) {
    const { record } = report;
    lines.push(
      `  run ${record.runner}${record.runnerVersion ? ` ${record.runnerVersion}` : ""} ` +
        `on node ${record.nodeVersion} (${record.platform}), isolation ${record.isolation.mode}, ` +
        `${record.durationMs}ms, exit ${record.exitCode ?? "none"}`,
    );
    const { counts } = record;
    lines.push(
      `  results ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ` +
        `${counts.timedOut} timed out, ${counts.errored} errored, ${counts.cancelled} cancelled, ` +
        `${counts.unsupported} unsupported`,
    );
  } else {
    lines.push("  run none (the requirement gate refused before execution)");
  }

  lines.push("", `reason: ${report.reason}`);

  if (report.result !== null) {
    lines.push("", `named test: ${report.result.status}`);
    if (report.result.message !== null) {
      lines.push(`  ${report.result.message}`);
    }
  } else if (report.record !== null) {
    lines.push("", "named test: no result reported");
  }

  const others = report.results.filter(
    (result) => result.id !== report.result?.id,
  );
  if (others.length > 0) {
    lines.push("", `other results in the same file (${others.length})`);
    for (const result of others) {
      lines.push(`  ${result.status.padEnd(11)} ${result.name}`);
    }
  }

  lines.push("", "limitations");
  for (const limitation of report.limitations) {
    lines.push(`  - ${limitation}`);
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

/** Human summary of what an export wrote. */
export function renderReproductionExportText(
  manifest: ReproductionExport,
  written: { test: string; manifest: string },
): string {
  const lines: string[] = [];

  lines.push(`reproduction export → ${manifest.id}`);
  lines.push(`  test ${written.test}`);
  lines.push(`  manifest ${written.manifest}`);
  lines.push(`  check ${manifest.check.file} › ${manifest.check.test}`);
  lines.push(
    `  evidence ${manifest.evidence.verdict} recorded ${manifest.evidence.generatedAt} ` +
      `against ${manifest.evidence.root}`,
  );
  if (manifest.requirement !== null) {
    lines.push(`  requirement ${manifest.requirement}`);
  }
  for (const file of manifest.files) {
    lines.push(`  file ${file.path} (${file.bytes} bytes, ${file.digest.slice(0, 21)}…)`);
  }

  lines.push("", "limitations");
  for (const limitation of manifest.limitations) {
    lines.push(`  - ${limitation}`);
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}
