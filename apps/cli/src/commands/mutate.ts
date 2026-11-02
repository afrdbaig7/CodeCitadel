import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EXIT_CODES,
  mutationReportSchema,
  type ExitCode,
} from "@codecitadel/contracts";
import { runMutationTesting } from "@codecitadel/core";

import { UsageError, parsePositiveInt } from "../errors.js";
import { renderMutationText } from "../render-mutation.js";

export interface MutateCommandOptions {
  format?: string;
  out?: string;
  threshold?: string;
  runner?: string;
  maxMutants?: string;
  timeoutMs?: string;
  files?: string[];
}

const FORMATS = ["text", "json"] as const;
type Format = (typeof FORMATS)[number];

function parseFormat(value: string | undefined): Format {
  const format = value ?? "text";
  if (!FORMATS.includes(format as Format)) {
    throw new UsageError(`--format must be one of ${FORMATS.join(", ")}, received "${format}".`);
  }
  return format as Format;
}

function parseThreshold(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 100) {
    throw new UsageError(`--threshold must be a number between 0 and 100, received "${value}".`);
  }
  return num;
}

async function collectFilesRecursively(dir: string, baseDir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name === "dist") {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await collectFilesRecursively(full, baseDir)));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (
          [".ts", ".js", ".tsx", ".jsx", ".mjs"].includes(ext) &&
          !entry.name.endsWith(".d.ts")
        ) {
          results.push(path.relative(baseDir, full).replace(/\\/g, "/"));
        }
      }
    }
  } catch {}
  return results;
}

export async function runMutateCommand(
  targetPath: string,
  options: MutateCommandOptions,
): Promise<ExitCode> {
  const format = parseFormat(options.format);
  const threshold = parseThreshold(options.threshold);
  const maxMutants = options.maxMutants ? parsePositiveInt(options.maxMutants, "--max-mutants") : 100;
  const timeoutMs = options.timeoutMs ? parsePositiveInt(options.timeoutMs, "--timeout-ms") : 15_000;

  const root = path.resolve(targetPath);
  const allFiles = await collectFilesRecursively(root, root);

  const testFiles = allFiles.filter(
    (f) =>
      f.includes(".test.") ||
      f.includes(".spec.") ||
      f.startsWith("test/") ||
      f.startsWith("tests/"),
  );

  let sourceFiles = options.files && options.files.length > 0
    ? options.files
    : allFiles.filter(
        (f) =>
          !f.includes(".test.") &&
          !f.includes(".spec.") &&
          !f.startsWith("test/") &&
          !f.startsWith("tests/"),
      );

  if (sourceFiles.length === 0) {
    throw new UsageError(`No source files found to mutate in ${root}.`);
  }

  const report = await runMutationTesting({
    root,
    files: sourceFiles,
    testFiles,
    maxMutants,
    timeoutMs,
    ...(options.runner ? { runner: options.runner } : {}),
  });

  const parsedReport = mutationReportSchema.parse(report);

  if (options.out) {
    await writeFile(path.resolve(options.out), JSON.stringify(parsedReport, null, 2), "utf8");
    process.stderr.write(`mutation report written to ${options.out}\n`);
  }

  const rendered =
    format === "json"
      ? `${JSON.stringify(parsedReport, null, 2)}\n`
      : renderMutationText(parsedReport, threshold);

  process.stdout.write(rendered);

  if (threshold !== undefined && parsedReport.summary.mutationScore < threshold) {
    process.stderr.write(
      `codecitadel: mutation score ${parsedReport.summary.mutationScore.toFixed(1)}% breached threshold ${threshold}%.\n`,
    );
    return EXIT_CODES.policyBreach;
  }

  return EXIT_CODES.ok;
}
