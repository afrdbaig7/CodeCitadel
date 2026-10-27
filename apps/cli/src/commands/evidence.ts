import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EXIT_CODES,
  patchVerificationReportSchema,
  reproductionReportSchema,
  testRunReportSchema,
  type EvidenceBundle,
  type ExitCode,
} from "@codecitadel/contracts";
import {
  createBundleFromPatchVerification,
  createBundleFromReproduction,
  createBundleFromRun,
} from "@codecitadel/core";

import { UsageError } from "../errors.js";
import { renderEvidenceExportText } from "../render-evidence.js";

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export interface EvidenceExportCommandOptions {
  out?: string;
  force?: boolean;
  format?: string;
}

/**
 * `codecitadel evidence export <report> [options]`
 *
 * Reads a stored verification report (reproduction, run, or patch verification),
 * packs all referenced artifacts, digests, and metadata into a self-contained,
 * tamper-evident Evidence Bundle.
 */
export async function runEvidenceExportCommand(
  reportPath: string,
  options: EvidenceExportCommandOptions,
): Promise<ExitCode> {
  const format = options.format ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be text or json, received "${format}".`);
  }

  const resolvedReportPath = path.resolve(reportPath);
  if (!(await fileExists(resolvedReportPath))) {
    throw new UsageError(`Report file at ${reportPath} does not exist.`);
  }

  let text: string;
  try {
    text = await readFile(resolvedReportPath, "utf8");
  } catch (error) {
    throw new UsageError(`Failed to read report at ${reportPath}: ${(error as Error).message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`Report file at ${reportPath} is not valid JSON: ${(error as Error).message}`);
  }

  let bundle: EvidenceBundle;

  // Try parsing as reproduction report
  const reproductionResult = reproductionReportSchema.safeParse(json);
  if (reproductionResult.success) {
    bundle = createBundleFromReproduction(reproductionResult.data);
  } else {
    // Try parsing as run report
    const runResult = testRunReportSchema.safeParse(json);
    if (runResult.success) {
      bundle = createBundleFromRun(runResult.data);
    } else {
      // Try parsing as patch verification report
      const patchResult = patchVerificationReportSchema.safeParse(json);
      if (patchResult.success) {
        // Read patch file if available
        bundle = createBundleFromPatchVerification(
          patchResult.data,
          "",
          "patch.diff",
        );
      } else {
        throw new UsageError(
          `File at ${reportPath} is not a recognised CodeCitadel report ` +
            "(expected a reproduction, run, or patch verification report).",
        );
      }
    }
  }

  const destination = path.resolve(
    options.out ?? path.join(".codecitadel", "bundles", `${bundle.id}.bundle.json`),
  );

  if (!options.force && (await fileExists(destination))) {
    throw new UsageError(
      `Refusing to overwrite existing bundle at ${destination}. Pass --force to overwrite.`,
    );
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(bundle, null, 2) + "\n", "utf8");

  if (format === "json") {
    process.stdout.write(JSON.stringify(bundle, null, 2) + "\n");
  } else {
    process.stdout.write(renderEvidenceExportText(bundle, destination));
  }

  return EXIT_CODES.ok;
}
