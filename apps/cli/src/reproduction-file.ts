import { readFile } from "node:fs/promises";

import {
  REPRODUCTION_SCHEMA_VERSION,
  reproductionReportSchema,
  type ReproductionDocument,
  type ReproductionReport,
} from "@codecitadel/contracts";
import { parseReproductionDocument, ReproductionError } from "@codecitadel/core";

import { UsageError } from "./errors.js";

/**
 * The manifest is user input, not evidence: it is read strictly so a mistyped
 * key is an error instead of a reproduction that silently never runs.
 */
export async function readReproductionDocument(file: string): Promise<ReproductionDocument> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new UsageError(`Cannot read the reproduction manifest at ${file}: ${(error as Error).message}`);
  }

  try {
    return parseReproductionDocument(raw, `The reproduction manifest at ${file}`);
  } catch (error) {
    if (error instanceof ReproductionError) {
      throw new UsageError(error.message);
    }
    throw error;
  }
}

/**
 * Reproduction reports are stored evidence: export reads one back, so a version
 * this build does not understand is refused with the way to create a new one.
 */
export async function readReproductionReport(file: string): Promise<ReproductionReport> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new UsageError(`Cannot read the reproduction report at ${file}: ${(error as Error).message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(
      `The reproduction report at ${file} is not valid JSON: ${(error as Error).message}`,
    );
  }

  const parsed = reproductionReportSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    throw new UsageError(
      `The reproduction report at ${file} does not match schema version ${REPRODUCTION_SCHEMA_VERSION}${location}: ` +
        `${issue?.message ?? "invalid report"}. Create one with \`codecitadel reproduce run <manifest> --id <id> --out <file> --format json\`.`,
    );
  }
  return parsed.data;
}
