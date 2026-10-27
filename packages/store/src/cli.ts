import { lstat } from "node:fs/promises";
import path from "node:path";

import { migrate, type MigrationResult } from "./migrate.js";

const USAGE =
  "codecitadel controlplane migrate [root] --applied-by <name>\n" +
  "  Create the control plane store and its first immutable manifest entry.\n" +
  "  The migration is atomic: store, manifest, and version are written together.\n" +
  "\n" +
  "  root                  Directory the store sits in (defaults to the current directory)\n" +
  "  --applied-by <name>   Who recorded the migration (default: codebuff)";

export async function runControlPlaneMigrate(args: string[]): Promise<{ result: MigrationResult; exitCode: number }> {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const named = args.filter((arg) => arg.startsWith("--"));
  const root = positional[0] ?? ".";
  const appliedBy = named.find((arg) => arg.startsWith("--applied-by="))?.slice("--applied-by=".length) ?? named.find((arg) => arg === "--applied-by")?.slice(11);

  const rootStats = await lstat(root).catch(() => null);
  if (rootStats === null || !rootStats.isDirectory()) {
    return { result: { storePath: "", manifestPath: "", sourceRoot: root, appliedBy: appliedBy ?? "codebuff", actor: "codebuff" }, exitCode: 2 };
  }

  const result = await migrate({ root, appliedBy: appliedBy ?? "codebuff", actor: "codebuff" });
  return { result, exitCode: 0 };
}
