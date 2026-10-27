import { EXIT_CODES, type ExitCode, type SnapshotDiff } from "@codecitadel/contracts";
import { buildSnapshot, diffSnapshots, introducedAtOrAbove, scanRepositoryDetailed } from "@codecitadel/core";

import { UsageError } from "../errors.js";
import { parseFailOn } from "../options.js";
import { renderDiffMarkdown, renderDiffText } from "../render.js";
import { readSnapshot, writeSnapshot } from "../snapshot-file.js";

export interface DiffCommandOptions {
  base?: string;
  format?: string;
  failOn?: string;
  saveSnapshot?: string;
  scanner?: string;
}

const FORMATS = ["text", "json", "markdown"] as const;
type Format = (typeof FORMATS)[number];

function parseFormat(value: string | undefined): Format {
  const format = value ?? "text";
  if (!FORMATS.includes(format as Format)) {
    throw new UsageError(
      `--format must be one of ${FORMATS.join(", ")} for diff, received "${format}".`,
    );
  }
  return format as Format;
}

function renderDiff(diff: SnapshotDiff, format: Format): string {
  switch (format) {
    case "json":
      return `${JSON.stringify(diff, null, 2)}\n`;
    case "markdown":
      return renderDiffMarkdown(diff);
    case "text":
      return renderDiffText(diff);
  }
}

/**
 * Compares a stored snapshot with the current working tree.
 *
 * The head side always comes from a fresh scan, never from a cached report: a
 * comparison against stale data would report changes that never happened. The
 * `--fail-on` default is `none` because a diff is an explanation; gating on
 * introduced findings is something the caller opts into.
 */
export async function runDiffCommand(
  pathArgument: string,
  options: DiffCommandOptions,
): Promise<ExitCode> {
  if (!options.base) {
    throw new UsageError("diff requires --base <snapshot.json>.");
  }

  const format = parseFormat(options.format);
  const failOn = parseFailOn(options.failOn, "none");

  const baseSnapshot = await readSnapshot(options.base);

  const scan = await scanRepositoryDetailed({
    root: pathArgument,
    ...(options.scanner !== undefined ? { scannerPath: options.scanner } : {}),
  });
  const headSnapshot = buildSnapshot({ report: scan.report, files: scan.files });

  if (options.saveSnapshot) {
    await writeSnapshot(options.saveSnapshot, headSnapshot);
    process.stderr.write(`snapshot written to ${options.saveSnapshot}\n`);
  }

  const diff = diffSnapshots(baseSnapshot, headSnapshot);
  process.stdout.write(renderDiff(diff, format));

  const { files, findings } = diff;
  process.stderr.write(
    `compared ${diff.base.files} base file(s) with ${diff.head.files} head file(s): ` +
      `+${files.added.length} added, ~${files.modified.length} modified, ` +
      `-${files.removed.length} removed, ${files.unverified.length} unverified; ` +
      `${findings.introduced.length} introduced, ${findings.resolved.length} resolved, ` +
      `${findings.unverified.length} unverified finding(s)\n`,
  );

  if (failOn === "none") {
    return EXIT_CODES.ok;
  }
  const breached = introducedAtOrAbove(diff, failOn);
  if (breached.length > 0) {
    process.stderr.write(
      `${breached.length} introduced finding(s) at or above "${failOn}" breached the policy ` +
        "(--fail-on none to ignore).\n",
    );
    return EXIT_CODES.policyBreach;
  }
  return EXIT_CODES.ok;
}
