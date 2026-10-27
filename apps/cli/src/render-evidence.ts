import type { EvidenceBundle, ReplayReport } from "@codecitadel/contracts";

export function renderEvidenceExportText(bundle: EvidenceBundle, destination: string): string {
  const lines: string[] = [];
  lines.push(`evidence export → ${bundle.id}`);
  lines.push(`  kind         ${bundle.kind}`);
  lines.push(`  destination  ${destination}`);
  lines.push(`  claim        ${bundle.claim.statement}`);
  lines.push(`  verdict      ${bundle.claim.expectedVerdict}`);
  lines.push(`  artifacts    ${bundle.artifacts.length} file(s) bundled`);
  for (const artifact of bundle.artifacts) {
    lines.push(`    - ${artifact.path} (${artifact.bytes} bytes, ${artifact.digest.slice(0, 19)}…)`);
  }
  if (bundle.permissions.env.length > 0) {
    lines.push(`  env needed   ${bundle.permissions.env.join(", ")}`);
  }
  lines.push("");
  lines.push("limitations");
  for (const lim of bundle.limitations) {
    lines.push(`  - ${lim}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderReplayText(report: ReplayReport): string {
  const lines: string[] = [];
  const statusUpper = report.verdict.toUpperCase();
  lines.push(`replay → ${statusUpper}`);
  lines.push(`  bundle       ${report.bundleId} (${report.bundleKind})`);
  lines.push(`  reason       ${report.reason}`);
  lines.push(
    `  claimed      ${report.original.verdict}` +
      (report.original.status ? ` (status: ${report.original.status})` : ""),
  );
  if (report.replayed !== null) {
    lines.push(
      `  replayed     ${report.replayed.verdict} (status: ${report.replayed.status}, ${report.replayed.durationMs}ms)`,
    );
    if (report.replayed.message) {
      lines.push(`    detail: ${report.replayed.message}`);
    }
  } else {
    lines.push(`  replayed     (not executed)`);
  }
  lines.push("");
  lines.push(
    `validation: verified ${report.validation.artifactCount} artifact(s) across ${report.validation.bundleBytes} bytes`,
  );
  lines.push("");
  lines.push("limitations");
  for (const lim of report.limitations) {
    lines.push(`  - ${lim}`);
  }
  return `${lines.join("\n")}\n`;
}
