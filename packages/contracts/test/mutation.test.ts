import { describe, expect, it } from "vitest";

import {
  calculateMutationScore,
  MUTATION_SCHEMA_VERSION,
  mutationReportSchema,
  mutationSummarySchema,
} from "../src/mutation.js";

describe("Mutation contracts", () => {
  it("calculates mutation score percentage correctly", () => {
    // 8 killed, 2 survived -> 80%
    expect(calculateMutationScore({ killed: 8, survived: 2, noCoverage: 0, timedOut: 0 })).toBe(80);

    // 5 killed, 1 timed out, 4 survived -> 60%
    expect(calculateMutationScore({ killed: 5, survived: 4, noCoverage: 0, timedOut: 1 })).toBe(60);

    // 0 viable mutants -> 100%
    expect(calculateMutationScore({ killed: 0, survived: 0, noCoverage: 0, timedOut: 0 })).toBe(100);

    // 0 killed, 10 survived -> 0%
    expect(calculateMutationScore({ killed: 0, survived: 10, noCoverage: 0, timedOut: 0 })).toBe(0);
  });

  it("validates a full mutation report against schema", () => {
    const report = {
      schemaVersion: MUTATION_SCHEMA_VERSION,
      tool: { name: "codecitadel" as const, version: "0.1.0" },
      scope: {
        root: "/workspace/my-app",
        filesAnalyzed: 2,
        durationMs: 1420,
        changedOnly: false,
      },
      mutants: [
        {
          id: "m_1",
          mutatorName: "EqualityOperator",
          location: {
            path: "src/discount.ts",
            startLine: 12,
            startColumn: 14,
            endLine: 12,
            endColumn: 17,
          },
          original: "===",
          replacement: "!==",
          status: "killed" as const,
          killingTest: "discount > calculates 20% discount for orders over 100",
          diff: "@@ -12,1 +12,1 @@\n-  if (total === 100)\n+  if (total !== 100)",
          description: 'Replaced "===" with "!==" in src/discount.ts:12',
        },
        {
          id: "m_2",
          mutatorName: "ArithmeticOperator",
          location: {
            path: "src/discount.ts",
            startLine: 15,
            startColumn: 18,
            endLine: 15,
            endColumn: 19,
          },
          original: "*",
          replacement: "/",
          status: "survived" as const,
          diff: "@@ -15,1 +15,1 @@\n-  return total * 0.8\n+  return total / 0.8",
          description: 'Replaced "*" with "/" in src/discount.ts:15',
        },
      ],
      summary: {
        total: 2,
        killed: 1,
        survived: 1,
        noCoverage: 0,
        timedOut: 0,
        compileError: 0,
        ignored: 0,
        unsupported: 0,
        mutationScore: 50,
        coveredMutants: 2,
      },
    };

    const parsed = mutationReportSchema.safeParse(report);
    expect(parsed.success).toBe(true);
  });
});
