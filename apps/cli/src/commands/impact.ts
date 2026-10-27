import { EXIT_CODES, type ExitCode } from "@codecitadel/contracts";

import { analyzeChanges } from "../analyze.js";
import { UsageError } from "../errors.js";
import { renderImpactText } from "../render.js";
import { readSnapshot } from "../snapshot-file.js";

export interface ImpactCommandOptions {
  base?: string;
  format?: string;
  scanner?: string;
}

const FORMATS = ["text", "json"] as const;
type Format = (typeof FORMATS)[number];

function parseFormat(value: string | undefined): Format {
  const format = value ?? "text";
  if (!FORMATS.includes(format as Format)) {
    throw new UsageError(
      `--format must be one of ${FORMATS.join(", ")} for impact, received "${format}".`,
    );
  }
  return format as Format;
}

/**
 * Names the tests that can see the changes since a stored snapshot.
 *
 * The pipeline itself lives in `analyzeChanges` (stored baseline → fresh scan →
 * change diff → module graph → backwards reachability). `run` uses the same
 * helper, so the tests listed here and the tests executed there cannot drift.
 *
 * Exit code is always 0 on success. Selecting tests is advice, not a gate: making
 * a review fail because a test file exists upstream of a change would punish the
 * normal case.
 */
export async function runImpactCommand(
  pathArgument: string,
  options: ImpactCommandOptions,
): Promise<ExitCode> {
  if (!options.base) {
    throw new UsageError("impact requires --base <snapshot.json>.");
  }

  const format = parseFormat(options.format);
  const baseSnapshot = await readSnapshot(options.base);

  const { impact } = await analyzeChanges({
    root: pathArgument,
    baseSnapshot,
    scannerPath: options.scanner,
  });

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(impact, null, 2)}\n`);
  } else {
    process.stdout.write(renderImpactText(impact));
  }

  process.stderr.write(
    `${impact.changed.length} changed file(s), ${impact.graph.modules} module(s) analyzed, ` +
      `${impact.tests.selected.length} of ${impact.graph.testFiles} test file(s) can see the change` +
      `${impact.complete ? "" : " (graph incomplete; selection is a lower bound)"}\n`,
  );

  return EXIT_CODES.ok;
}
