import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  calculateMutationScore,
  MUTATION_SCHEMA_VERSION,
  type Mutant,
  type MutantLocation,
  type MutantStatus,
  type MutationReport,
  type MutationSummary,
} from "@codecitadel/contracts";
import {
  createSourceCopy,
  executeTests,
  resolveVitestRunner,
  type SourceCopy,
} from "@codecitadel/executor";

import { CODECITADEL_VERSION } from "./version.js";

export interface MutationOperator {
  name: string;
  pattern: RegExp;
  replace: (match: string) => string;
  description: (original: string, replacement: string) => string;
}

export const MUTATION_OPERATORS: readonly MutationOperator[] = [
  {
    name: "EqualityOperator",
    pattern: /(===|!==|==|!=)/g,
    replace: (match) => {
      switch (match) {
        case "===": return "!==";
        case "!==": return "===";
        case "==": return "!=";
        case "!=": return "==";
        default: return match;
      }
    },
    description: (orig, rep) => `Replaced equality operator "${orig}" with "${rep}"`,
  },
  {
    name: "ComparisonOperator",
    pattern: /(>=|<=|>|<)/g,
    replace: (match) => {
      switch (match) {
        case ">=": return "<";
        case "<=": return ">";
        case ">": return "<=";
        case "<": return ">=";
        default: return match;
      }
    },
    description: (orig, rep) => `Replaced comparison operator "${orig}" with "${rep}"`,
  },
  {
    name: "ArithmeticOperator",
    pattern: /(\+|\-|\*|\/)/g,
    replace: (match) => {
      switch (match) {
        case "+": return "-";
        case "-": return "+";
        case "*": return "/";
        case "/": return "*";
        default: return match;
      }
    },
    description: (orig, rep) => `Replaced arithmetic operator "${orig}" with "${rep}"`,
  },
  {
    name: "BooleanLiteral",
    pattern: /\b(true|false)\b/g,
    replace: (match) => (match === "true" ? "false" : "true"),
    description: (orig, rep) => `Replaced boolean literal "${orig}" with "${rep}"`,
  },
  {
    name: "LogicalOperator",
    pattern: /(&&|\|\||\?\?)/g,
    replace: (match) => {
      switch (match) {
        case "&&": return "||";
        case "||": return "&&";
        case "??": return "||";
        default: return match;
      }
    },
    description: (orig, rep) => `Replaced logical operator "${orig}" with "${rep}"`,
  },
];

export interface DiscoveredMutantCandidate {
  id: string;
  mutatorName: string;
  location: MutantLocation;
  original: string;
  replacement: string;
  diff: string;
  description: string;
  lineIndex: number;
  originalLine: string;
  mutatedLine: string;
}

/**
 * Finds all potential mutants in a single source file string.
 */
export function discoverMutantsInContent(
  relativePath: string,
  content: string,
  idPrefix = "m",
): DiscoveredMutantCandidate[] {
  const lines = content.split(/\r?\n/);
  const candidates: DiscoveredMutantCandidate[] = [];
  let counter = 1;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (line === undefined) continue;
    const trimmed = line.trim();
    // Skip empty lines, import statements, comments
    if (
      trimmed === "" ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("import ") ||
      trimmed.startsWith("export type ") ||
      trimmed.startsWith("export interface ")
    ) {
      continue;
    }

    for (const op of MUTATION_OPERATORS) {
      op.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = op.pattern.exec(line)) !== null) {
        const original = match[0];
        const replacement = op.replace(original);
        if (original === replacement) continue;

        const startColumn = match.index + 1;
        const endColumn = startColumn + original.length;

        const mutatedLine =
          line.substring(0, match.index) + replacement + line.substring(match.index + original.length);

        const diff = [
          `--- a/${relativePath}`,
          `+++ b/${relativePath}`,
          `@@ -${lineIdx + 1},1 +${lineIdx + 1},1 @@`,
          `-${line}`,
          `+${mutatedLine}`,
        ].join("\n");

        candidates.push({
          id: `${idPrefix}_${counter++}`,
          mutatorName: op.name,
          location: {
            path: relativePath,
            startLine: lineIdx + 1,
            startColumn,
            endLine: lineIdx + 1,
            endColumn,
          },
          original,
          replacement,
          diff,
          description: `${op.description(original, replacement)} at ${relativePath}:${lineIdx + 1}:${startColumn}`,
          lineIndex: lineIdx,
          originalLine: line,
          mutatedLine,
        });
      }
    }
  }

  return candidates;
}

export interface RunMutationTestingOptions {
  root: string;
  files: readonly string[];
  testFiles?: readonly string[];
  maxMutants?: number;
  timeoutMs?: number;
  runner?: string;
}

/**
 * Runs mutation testing against the specified files in disposable workspace copies.
 * Never mutates original source files on disk.
 */
export async function runMutationTesting(options: RunMutationTestingOptions): Promise<MutationReport> {
  const startTime = Date.now();
  const root = path.resolve(options.root);
  const maxMutants = options.maxMutants ?? 100;

  // 1. Discover all candidate mutants across target files
  const candidates: { candidate: DiscoveredMutantCandidate; fullPath: string }[] = [];
  for (const file of options.files) {
    const fullPath = path.resolve(root, file);
    const relPath = path.relative(root, fullPath).replace(/\\/g, "/");
    let content: string;
    try {
      content = await readFile(fullPath, "utf8");
    } catch {
      continue;
    }
    const fileMutants = discoverMutantsInContent(relPath, content, `m_${candidates.length + 1}`);
    for (const mutant of fileMutants) {
      candidates.push({ candidate: mutant, fullPath });
      if (candidates.length >= maxMutants) break;
    }
    if (candidates.length >= maxMutants) break;
  }

  // 2. Resolve runner before evaluating
  const runnerResult = await resolveVitestRunner({ root, explicit: options.runner });
  const executedMutants: Mutant[] = [];

  let killed = 0;
  let survived = 0;
  let timedOut = 0;
  let compileError = 0;
  let noCoverage = 0;

  // 3. Evaluate each mutant inside a disposable workspace copy
  for (const { candidate } of candidates) {
    let copy: SourceCopy | undefined;
    try {
      copy = await createSourceCopy(root);
      const targetInCopy = path.join(copy.dir, candidate.location.path);

      // Read current copy content, mutate target line, and write back
      const copyContent = await readFile(targetInCopy, "utf8");
      const lines = copyContent.split(/\r?\n/);
      if (lines[candidate.lineIndex] !== undefined) {
        lines[candidate.lineIndex] = candidate.mutatedLine;
        await writeFile(targetInCopy, lines.join("\n"), "utf8");
      }

      // Execute tests against mutated copy
      const testResult = await executeTests({
        root: copy.dir,
        runner: runnerResult?.entry,
        testFiles: options.testFiles ?? [],
        timeoutMs: options.timeoutMs ?? 15_000,
        isolation: "none", // Already running inside an isolated disposable copy
      });

      let status: MutantStatus;
      let killingTest: string | undefined;

      if (testResult.record.status === "timed_out") {
        status = "timed_out";
        timedOut += 1;
      } else if (testResult.record.status === "errored") {
        status = "compile_error";
        compileError += 1;
      } else if (testResult.record.status === "failed") {
        status = "killed";
        killed += 1;
        // Find the first failing test from results
        const failedTest = testResult.results.find((t) => t.status === "failed");
        killingTest = failedTest ? `${failedTest.file} > ${failedTest.name}` : undefined;
      } else if (testResult.record.status === "passed") {
        // Tests passed despite the mutation -> mutant SURVIVED!
        status = "survived";
        survived += 1;
      } else {
        status = "no_coverage";
        noCoverage += 1;
      }

      executedMutants.push({
        id: candidate.id,
        mutatorName: candidate.mutatorName,
        location: candidate.location,
        original: candidate.original,
        replacement: candidate.replacement,
        status,
        ...(killingTest === undefined ? {} : { killingTest }),
        diff: candidate.diff,
        description: candidate.description,
      });
    } catch {
      executedMutants.push({
        id: candidate.id,
        mutatorName: candidate.mutatorName,
        location: candidate.location,
        original: candidate.original,
        replacement: candidate.replacement,
        status: "compile_error",
        diff: candidate.diff,
        description: candidate.description,
      });
      compileError += 1;
    } finally {
      if (copy) {
        await copy.dispose().catch(() => {});
      }
    }
  }

  const durationMs = Date.now() - startTime;
  const total = executedMutants.length;
  const score = calculateMutationScore({ killed, survived, noCoverage, timedOut });

  const summary: MutationSummary = {
    total,
    killed,
    survived,
    noCoverage,
    timedOut,
    compileError,
    ignored: 0,
    unsupported: 0,
    mutationScore: score,
    coveredMutants: killed + survived + timedOut,
  };

  return {
    schemaVersion: MUTATION_SCHEMA_VERSION,
    tool: {
      name: "codecitadel",
      version: CODECITADEL_VERSION,
    },
    scope: {
      root,
      filesAnalyzed: options.files.length,
      durationMs,
      changedOnly: false,
    },
    mutants: executedMutants,
    summary,
  };
}
