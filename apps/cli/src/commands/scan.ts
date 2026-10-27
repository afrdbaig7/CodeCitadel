import { writeFile } from "node:fs/promises";

import {
  EXIT_CODES,
  type ExitCode,
  type CodeCitadelReport,
  type ScanOptionsInput,
} from "@codecitadel/contracts";
import {
  buildSnapshot,
  findingsAtOrAbove,
  scanRepositoryDetailed,
  type ScanRepositoryInput,
} from "@codecitadel/core";

import { UsageError, parsePositiveInt } from "../errors.js";
import { parseFailOn } from "../options.js";
import { renderMarkdown } from "../render.js";
import { renderSarif } from "../sarif.js";
import { writeSnapshot } from "../snapshot-file.js";

export interface ScanCommandOptions {
  format?: string;
  out?: string;
  failOn?: string;
  rules?: string[];
  exclude?: string[];
  maxFiles?: string;
  scanner?: string;
  saveSnapshot?: string;
  verbose?: boolean;
}

const FORMATS = ["json", "markdown", "sarif"] as const;
type Format = (typeof FORMATS)[number];

function parseFormat(value: string | undefined): Format {
  const format = value ?? "json";
  if (!FORMATS.includes(format as Format)) {
    throw new UsageError(
      `--format must be one of ${FORMATS.join(", ")}, received "${format}".`,
    );
  }
  return format as Format;
}

function buildScanOptions(options: ScanCommandOptions): ScanOptionsInput {
  const scanOptions: ScanOptionsInput = {};
  if (options.rules && options.rules.length > 0) {
    scanOptions.rules = options.rules;
  }
  if (options.exclude && options.exclude.length > 0) {
    scanOptions.exclude = options.exclude;
  }
  if (options.maxFiles !== undefined) {
    scanOptions.maxFiles = parsePositiveInt(options.maxFiles, "--max-files");
  }
  return scanOptions;
}

function formatReport(report: CodeCitadelReport, format: Format): string {
  switch (format) {
    case "markdown":
      return renderMarkdown(report);
    case "sarif":
      return renderSarif(report);
    case "json":
      return `${JSON.stringify(report, null, 2)}\n`;
  }
}

export async function runScanCommand(pathArgument: string, options: ScanCommandOptions): Promise<ExitCode> {
  const format = parseFormat(options.format);
  const failOn = parseFailOn(options.failOn, "high");
  const scanOptions = buildScanOptions(options);

  const engineInput: ScanRepositoryInput = { root: pathArgument };
  if (Object.keys(scanOptions).length > 0) {
    engineInput.options = scanOptions;
  }
  if (options.scanner !== undefined) {
    engineInput.scannerPath = options.scanner;
  }
  if (options.verbose) {
    engineInput.onEvent = (event) => {
      if (event.type === "file" && event.skipped) {
        process.stderr.write(`skipped ${event.path} (${event.skipped})\n`);
      } else if (event.type === "warning") {
        process.stderr.write(`warning ${event.code}: ${event.message}\n`);
      }
    };
  }

  const { report, files } = await scanRepositoryDetailed(engineInput);

  // Written before any report output so a rejected snapshot path fails loudly
  // instead of leaving a report that looks like it included a snapshot.
  if (options.saveSnapshot) {
    await writeSnapshot(options.saveSnapshot, buildSnapshot({ report, files }));
    process.stderr.write(`snapshot written to ${options.saveSnapshot}\n`);
  }

  const rendered = formatReport(report, format);

  if (options.out) {
    await writeFile(options.out, rendered, "utf8");
    process.stderr.write(`report written to ${options.out}\n`);
  } else {
    process.stdout.write(rendered);
  }

  const { bySeverity, findings } = report.summary;
  process.stderr.write(
    `scanned ${report.scope.filesScanned} file(s), skipped ${report.scope.filesSkipped}, ` +
      `found ${findings} finding(s) in ${report.scope.durationMs}ms ` +
      `(critical ${bySeverity.critical}, high ${bySeverity.high}, medium ${bySeverity.medium})\n`,
  );
  if (report.scope.truncated) {
    process.stderr.write(
      `scan was truncated by limits (${report.scope.limitsHit.join(", ")}); results cover only the scanned scope\n`,
    );
  }

  if (failOn === "none") {
    return EXIT_CODES.ok;
  }
  const breach = findingsAtOrAbove(report.findings, failOn);
  if (breach.length > 0) {
    process.stderr.write(
      `${breach.length} finding(s) at or above "${failOn}" breached the policy (--fail-on none to ignore).\n`,
    );
    return EXIT_CODES.policyBreach;
  }
  return EXIT_CODES.ok;
}
