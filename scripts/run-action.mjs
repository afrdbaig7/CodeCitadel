#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function getInput(name, defaultValue = "") {
  const envName = `INPUT_${name.toUpperCase().replace(/-/g, "_")}`;
  const value = process.env[envName];
  if (value !== undefined && value !== "") return value.trim();
  return defaultValue;
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile && existsSync(path.dirname(outputFile))) {
    writeFileSync(outputFile, `${name}=${value}\n`, { flag: "a", encoding: "utf8" });
  } else {
    process.stdout.write(`::set-output name=${name}::${value}\n`);
  }
}

function appendStepSummary(markdown) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile && existsSync(path.dirname(summaryFile))) {
    writeFileSync(summaryFile, `${markdown}\n\n`, { flag: "a", encoding: "utf8" });
  }
}

function resolveCliPath() {
  const actionPath = process.env.ACTION_PATH || repoRoot;
  const candidates = [
    path.join(actionPath, "apps", "cli", "dist", "index.js"),
    path.join(repoRoot, "apps", "cli", "dist", "index.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot locate CodeCitadel CLI dist entry point. Looked in: ${candidates.join(", ")}`);
}

function formatSummaryTable(report, breachCount, failOn) {
  const { summary, scope } = report;
  const isBreached = breachCount > 0;
  const icon = isBreached ? "❌" : "✅";
  const statusText = isBreached
    ? `**Policy Breached**: ${breachCount} finding(s) meet or exceed the \`${failOn}\` threshold.`
    : `**Passed**: All findings meet the \`${failOn}\` policy.`;

  const lines = [
    `# ${icon} CodeCitadel Verification Summary`,
    "",
    statusText,
    "",
    "### Overview",
    "| Metric | Value |",
    "| :--- | :--- |",
    `| **Files Scanned** | ${scope.filesScanned} |`,
    `| **Files Skipped** | ${scope.filesSkipped} |`,
    `| **Duration** | ${scope.durationMs}ms |`,
    `| **Total Findings** | ${summary.findings} |`,
    `| **Critical** | ${summary.bySeverity.critical} |`,
    `| **High** | ${summary.bySeverity.high} |`,
    `| **Medium** | ${summary.bySeverity.medium} |`,
    `| **Low** | ${summary.bySeverity.low} |`,
    `| **Info** | ${summary.bySeverity.info} |`,
    "",
  ];

  if (report.findings.length > 0) {
    lines.push("### Findings Detail", "", "| Severity | Rule | Location | Explanation |", "| :--- | :--- | :--- | :--- |");
    for (const finding of report.findings.slice(0, 50)) {
      const loc = `${finding.location.path}:${finding.location.startLine}`;
      const rule = `\`${finding.ruleId}\``;
      const explanation = finding.explanation.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
      lines.push(`| **${finding.severity.toUpperCase()}** | ${rule} | \`${loc}\` | ${explanation} |`);
    }
    if (report.findings.length > 50) {
      lines.push("", `*...and ${report.findings.length - 50} more finding(s) omitted from summary table.*`);
    }
    lines.push("");
  }

  lines.push(
    "> [!NOTE]",
    "> CodeCitadel performs static analysis, AST impact tracing, and behavioral verification to prevent AI slop and test weakening.",
    "> Learn more at [CodeCitadel Documentation](https://github.com/afrdbaig7/CodeCitadel).",
  );

  return lines.join("\n");
}

export async function runAction() {
  const targetPath = getInput("path", ".");
  const command = getInput("command", "scan");
  const failOn = getInput("fail-on", "high");
  const sarifFile = getInput("sarif-file", "codecitadel-results.sarif");
  const reportFile = getInput("report-file", "");
  const rules = getInput("rules", "");
  const writeSummary = getInput("write-summary", "true") === "true";
  const shouldUpload = getInput("upload", "false") === "true";
  const server = getInput("server", "");
  const token = getInput("token", process.env.CODECITADEL_TOKEN || "");
  const organization = getInput("organization", "");

  const cliPath = resolveCliPath();

  if (command !== "scan") {
    process.stderr.write(`codecitadel-action: command "${command}" is not yet automated by this action runner (supported: "scan").\n`);
    process.exit(2);
  }

  // 1. Run JSON scan with fail-on none so we get the full report regardless of findings
  const scanArgs = [cliPath, "scan", targetPath, "--format", "json", "--fail-on", "none"];
  if (rules) {
    for (const rule of rules.split(",").map((r) => r.trim()).filter(Boolean)) {
      scanArgs.push("--rules", rule);
    }
  }

  process.stdout.write(`::group::Running CodeCitadel scan on ${targetPath}\n`);
  let scanStdout = "";
  let scanStderr = "";
  try {
    const result = await execFileAsync(process.execPath, scanArgs, {
      cwd: process.cwd(),
      maxBuffer: 30 * 1024 * 1024,
    });
    scanStdout = result.stdout;
    scanStderr = result.stderr;
  } catch (error) {
    const failure = error;
    scanStdout = failure.stdout ?? "";
    scanStderr = failure.stderr ?? "";
    if (!scanStdout) {
      process.stderr.write(scanStderr || failure.message);
      process.stdout.write("::endgroup::\n");
      process.exit(failure.code || 2);
    }
  }
  process.stdout.write("::endgroup::\n");
  if (scanStderr) {
    process.stderr.write(scanStderr);
  }

  let report;
  try {
    report = JSON.parse(scanStdout);
  } catch (parseError) {
    process.stderr.write(`codecitadel-action: failed to parse scan JSON output: ${parseError.message}\n`);
    process.exit(2);
  }

  // 2. Generate SARIF report
  if (sarifFile) {
    const sarifArgs = [cliPath, "scan", targetPath, "--format", "sarif", "--fail-on", "none"];
    if (rules) {
      for (const rule of rules.split(",").map((r) => r.trim()).filter(Boolean)) {
        sarifArgs.push("--rules", rule);
      }
    }
    try {
      const sarifResult = await execFileAsync(process.execPath, sarifArgs, {
        cwd: process.cwd(),
        maxBuffer: 30 * 1024 * 1024,
      });
      const resolvedSarifPath = path.resolve(sarifFile);
      mkdirSync(path.dirname(resolvedSarifPath), { recursive: true });
      writeFileSync(resolvedSarifPath, sarifResult.stdout, "utf8");
      process.stdout.write(`Emitted SARIF 2.1.0 to ${resolvedSarifPath}\n`);
      setOutput("sarif-file", resolvedSarifPath);
    } catch (sarifError) {
      process.stderr.write(`codecitadel-action: failed to emit SARIF: ${sarifError.message}\n`);
    }
  }

  // 3. Save raw report if requested
  if (reportFile) {
    const resolvedReportPath = path.resolve(reportFile);
    mkdirSync(path.dirname(resolvedReportPath), { recursive: true });
    writeFileSync(resolvedReportPath, scanStdout, "utf8");
    process.stdout.write(`Saved raw report to ${resolvedReportPath}\n`);
  }

  // 4. Calculate policy breaches
  const severityOrder = ["low", "medium", "high", "critical"];
  const failIndex = severityOrder.indexOf(failOn);
  let breachCount = 0;
  if (failOn !== "none" && failIndex !== -1) {
    for (const finding of report.findings) {
      const findingIndex = severityOrder.indexOf(finding.severity);
      if (findingIndex >= failIndex) {
        breachCount += 1;
      }
    }
  }

  // 5. Write GitHub Step Summary
  if (writeSummary) {
    const summaryMarkdown = formatSummaryTable(report, breachCount, failOn);
    appendStepSummary(summaryMarkdown);
  }

  // 6. Set Outputs
  setOutput("findings-count", report.summary.findings);
  setOutput("breach-count", breachCount);
  setOutput("verdict", breachCount === 0 ? "passed" : "failed");

  // 7. Optional control plane upload
  if (shouldUpload && server && token) {
    process.stdout.write(`::group::Uploading report to CodeCitadel control plane (${server})\n`);
    const tempReportPath = path.resolve(`.codecitadel-upload-${Date.now()}.json`);
    writeFileSync(tempReportPath, scanStdout, "utf8");
    const uploadArgs = [cliPath, "upload", tempReportPath, "--server", server, "--token", token];
    if (organization) {
      uploadArgs.push("--organization", organization);
    }
    try {
      const uploadResult = await execFileAsync(process.execPath, uploadArgs, {
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024,
      });
      process.stdout.write(uploadResult.stdout);
    } catch (uploadError) {
      process.stderr.write(`codecitadel-action: upload failed: ${uploadError.message}\n`);
    } finally {
      try {
        if (existsSync(tempReportPath)) {
          // unlink temp file
          const { unlinkSync } = await import("node:fs");
          unlinkSync(tempReportPath);
        }
      } catch {}
      process.stdout.write("::endgroup::\n");
    }
  }

  // 8. Exit with policy decision
  if (breachCount > 0) {
    process.stderr.write(`codecitadel: ${breachCount} finding(s) meet or exceed "${failOn}" policy. Failing check.\n`);
    process.exit(1);
  }

  process.stdout.write(`codecitadel: 0 findings breached "${failOn}" policy. Check passed.\n`);
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runAction().catch((error) => {
    process.stderr.write(`codecitadel-action fatal: ${error.message}\n`);
    process.exit(2);
  });
}
