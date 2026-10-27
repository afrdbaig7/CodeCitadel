import { readFile } from "node:fs/promises";

import {
  EXECUTION_SCHEMA_VERSION,
  testRunReportSchema,
  type TestRunReport,
} from "@codecitadel/contracts";

import { UsageError } from "./errors.js";

/**
 * Run reports are stored evidence, so reading is strict: a file that does not
 * match this build's schema version is rejected with the way to re-create it.
 */
export async function readRunReport(file: string): Promise<TestRunReport> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new UsageError(`Cannot read the run report at ${file}: ${(error as Error).message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`The run report at ${file} is not valid JSON: ${(error as Error).message}`);
  }

  const parsed = testRunReportSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    throw new UsageError(
      `The run report at ${file} does not match schema version ${EXECUTION_SCHEMA_VERSION}${location}: ` +
        `${issue?.message ?? "invalid report"}. Create one with \`codecitadel run --out <file> --format json\`.`,
    );
  }
  return parsed.data;
}
