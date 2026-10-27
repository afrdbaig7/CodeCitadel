import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  REQUIREMENT_DOCUMENT_FILE,
  requirementDocumentSchema,
  type RequirementDocument,
} from "@codecitadel/contracts";
import { parseRequirementDocument, RequirementDocumentError } from "@codecitadel/core";

import { UsageError } from "./errors.js";

/**
 * A path argument may name the document itself or the directory that holds the
 * default file name. Anything else is an explicit choice by the caller.
 */
export function requirementDocumentPath(target: string): string {
  return /\.json$/i.test(target) ? target : path.join(target, REQUIREMENT_DOCUMENT_FILE);
}

export async function readRequirementDocument(file: string): Promise<RequirementDocument> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new UsageError(
      `Cannot read the requirement document at ${file}: ${(error as Error).message}. ` +
        `Create one named ${REQUIREMENT_DOCUMENT_FILE} or pass the file path.`,
    );
  }

  try {
    return parseRequirementDocument(raw, `The requirement document at ${file}`);
  } catch (error) {
    if (error instanceof RequirementDocumentError) {
      throw new UsageError(error.message);
    }
    throw error;
  }
}

/**
 * Writes only a document that already validated. The rewrite is the whole file:
 * a partial edit would leave a requirement's digest describing text that is no
 * longer in the file.
 */
export async function writeRequirementDocument(
  file: string,
  document: RequirementDocument,
): Promise<void> {
  const validated = requirementDocumentSchema.parse(document);
  try {
    await writeFile(file, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  } catch (error) {
    throw new UsageError(
      `Cannot write the requirement document at ${file}: ${(error as Error).message}`,
    );
  }
}
