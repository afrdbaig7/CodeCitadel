import os from "node:os";

import { EXIT_CODES, type ExitCode } from "@codecitadel/contracts";
import {
  acceptRequirement,
  evaluateRequirements,
  RequirementDocumentError,
  summarizeRequirements,
} from "@codecitadel/core";

import { UsageError } from "../errors.js";
import {
  readRequirementDocument,
  requirementDocumentPath,
  writeRequirementDocument,
} from "../requirement-file.js";
import {
  renderRequirementsEvaluationText,
  renderRequirementsSummaryText,
} from "../render-requirements.js";
import { readRunReport } from "../run-report-file.js";

const FORMATS = ["text", "json"] as const;
type Format = (typeof FORMATS)[number];

function parseFormat(value: string | undefined, command: string): Format {
  const format = value ?? "text";
  if (!FORMATS.includes(format as Format)) {
    throw new UsageError(
      `--format must be one of ${FORMATS.join(", ")} for ${command}, received "${format}".`,
    );
  }
  return format as Format;
}

export interface RequirementsListCommandOptions {
  format?: string;
}

/**
 * Reads the document and says whether each acceptance still covers the text.
 *
 * Exit codes: 0 when no requirement carries a stale acceptance, 2 when one
 * does. A stale acceptance is an approval that no longer applies, which is an
 * error to surface rather than a detail to bury in the output.
 */
export async function runRequirementsListCommand(
  target: string,
  options: RequirementsListCommandOptions,
): Promise<ExitCode> {
  const format = parseFormat(options.format, "requirements list");
  const file = requirementDocumentPath(target);
  const document = await readRequirementDocument(file);
  const summary = summarizeRequirements(document);
  process.stdout.write(
    format === "json"
      ? `${JSON.stringify(summary, null, 2)}\n`
      : renderRequirementsSummaryText(summary),
  );

  if (summary.counts.stale > 0) {
    process.stderr.write(
      `stale: ${summary.counts.stale} requirement(s) changed after acceptance; ` +
        "accept the current text again or revert the edit\n",
    );
    return EXIT_CODES.error;
  }
  return EXIT_CODES.ok;
}

export interface RequirementsAcceptCommandOptions {
  by?: string;
}

/**
 * The explicit acceptance act. It writes the signature and the digest of the
 * text it applies to; nothing infers an acceptance, and nothing else can make
 * a requirement verifiable.
 */
export async function runRequirementsAcceptCommand(
  id: string,
  target: string,
  options: RequirementsAcceptCommandOptions,
): Promise<ExitCode> {
  const file = requirementDocumentPath(target);
  const document = await readRequirementDocument(file);
  const acceptedBy = options.by?.trim() || os.userInfo().username || "local-user";

  let accepted;
  try {
    accepted = acceptRequirement({ document, id, acceptedBy });
  } catch (error) {
    if (error instanceof RequirementDocumentError) {
      throw new UsageError(error.message);
    }
    throw error;
  }

  await writeRequirementDocument(file, accepted);
  const requirement = accepted.requirements.find((entry) => entry.id === id);
  process.stdout.write(
    `accepted ${id} by ${acceptedBy}\n` +
      `  digest ${requirement?.acceptance?.digest ?? "(missing)"}\n` +
      `  wrote  ${file}\n`,
  );
  return EXIT_CODES.ok;
}

export interface RequirementsCheckCommandOptions {
  report: string;
  format?: string;
}

/**
 * Evaluates every registered check against one stored run report.
 *
 * Exit codes: 0 when every accepted requirement is met, 1 when one is unmet,
 * 2 when a requirement is inconclusive, or when an acceptance is stale. A
 * proposed or rejected requirement is reported but not evaluated: nothing
 * accepted it, so it cannot pass or fail.
 */
export async function runRequirementsCheckCommand(
  target: string,
  options: RequirementsCheckCommandOptions,
): Promise<ExitCode> {
  const format = parseFormat(options.format, "requirements check");
  const file = requirementDocumentPath(target);
  const [document, report] = await Promise.all([
    readRequirementDocument(file),
    readRunReport(options.report),
  ]);

  const evaluation = evaluateRequirements({ document, report });
  process.stdout.write(
    format === "json"
      ? `${JSON.stringify(evaluation, null, 2)}\n`
      : renderRequirementsEvaluationText(evaluation),
  );

  const stale = evaluation.requirements.filter((entry) => entry.acceptance === "stale").length;
  if (stale > 0) {
    process.stderr.write(
      `stale: ${stale} requirement(s) changed after acceptance; no result can satisfy them\n`,
    );
    return EXIT_CODES.error;
  }

  const unaccepted = evaluation.requirements.filter(
    (entry) => entry.acceptance === "missing",
  ).length;
  if (unaccepted > 0) {
    process.stderr.write(
      `not accepted: ${unaccepted} requirement(s) were listed but not evaluated; ` +
        "they do not affect this exit code\n",
    );
  }

  if (evaluation.counts.unmet > 0) {
    return EXIT_CODES.policyBreach;
  }
  if (evaluation.counts.inconclusive > 0) {
    return EXIT_CODES.error;
  }
  return EXIT_CODES.ok;
}
