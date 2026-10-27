import { readFile, writeFile } from "node:fs/promises";

import {
  SNAPSHOT_SCHEMA_VERSION,
  snapshotSchema,
  type Snapshot,
} from "@codecitadel/contracts";

import { UsageError } from "./errors.js";

/**
 * Snapshot files are stored evidence, so both directions are strict:
 *
 * - Reading validates against the schema version this build understands. A
 *   snapshot from another schema is rejected instead of being interpreted
 *   loosely, because guessing at field meaning would invent evidence.
 * - Writing uses the `wx` flag, which fails if the file exists. Snapshots are
 *   immutable: rewriting one would silently erase the baseline someone else's
 *   comparison depends on.
 */
export async function readSnapshot(file: string): Promise<Snapshot> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new UsageError(`Cannot read the snapshot at ${file}: ${(error as Error).message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`The snapshot at ${file} is not valid JSON: ${(error as Error).message}`);
  }

  const parsed = snapshotSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    throw new UsageError(
      `The snapshot at ${file} does not match schema version ${SNAPSHOT_SCHEMA_VERSION}${location}: ` +
        `${issue?.message ?? "invalid snapshot"}. Re-create it with \`codecitadel scan --save-snapshot\`.`,
    );
  }
  return parsed.data;
}

export async function writeSnapshot(file: string, snapshot: Snapshot): Promise<void> {
  try {
    await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new UsageError(
        `Refusing to overwrite the existing snapshot at ${file}. ` +
          "Snapshots are immutable evidence; write a new file name instead.",
      );
    }
    throw new UsageError(`Cannot write the snapshot to ${file}: ${(error as Error).message}`);
  }
}
