import { z } from "zod";

import { locationSchema } from "./finding.js";

export const MUTATION_SCHEMA_VERSION = 1;

export const MUTANT_STATUSES = [
  "killed",
  "survived",
  "no_coverage",
  "timed_out",
  "compile_error",
  "ignored",
  "unsupported",
] as const;

export type MutantStatus = (typeof MUTANT_STATUSES)[number];
export const mutantStatusSchema = z.enum(MUTANT_STATUSES);

export const mutantLocationSchema = z.strictObject({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
});
export type MutantLocation = z.infer<typeof mutantLocationSchema>;

export const mutantSchema = z.strictObject({
  id: z.string().min(1),
  mutatorName: z.string().min(1),
  location: mutantLocationSchema,
  original: z.string(),
  replacement: z.string(),
  status: mutantStatusSchema,
  killingTest: z.string().optional(),
  diff: z.string(),
  description: z.string().min(1),
});
export type Mutant = z.infer<typeof mutantSchema>;

export const mutationSummarySchema = z.strictObject({
  total: z.number().int().nonnegative(),
  killed: z.number().int().nonnegative(),
  survived: z.number().int().nonnegative(),
  noCoverage: z.number().int().nonnegative(),
  timedOut: z.number().int().nonnegative(),
  compileError: z.number().int().nonnegative(),
  ignored: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(),
  /**
   * Mutation score as a percentage (0.0 to 100.0).
   * Formula: (killed + timedOut) / (killed + survived + noCoverage + timedOut) * 100
   * When denominator is 0, score is 100.0 (no testable mutants survived).
   */
  mutationScore: z.number().min(0).max(100),
  coveredMutants: z.number().int().nonnegative(),
});
export type MutationSummary = z.infer<typeof mutationSummarySchema>;

export const mutationReportSchema = z.strictObject({
  schemaVersion: z.literal(MUTATION_SCHEMA_VERSION),
  tool: z.strictObject({
    name: z.literal("codecitadel"),
    version: z.string().min(1),
  }),
  scope: z.strictObject({
    root: z.string().min(1),
    filesAnalyzed: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    changedOnly: z.boolean(),
  }),
  mutants: z.array(mutantSchema),
  summary: mutationSummarySchema,
});
export type MutationReport = z.infer<typeof mutationReportSchema>;

/**
 * Calculates the standard mutation score:
 * (killed + timedOut) / (killed + survived + noCoverage + timedOut) * 100
 */
export function calculateMutationScore(counts: {
  killed: number;
  survived: number;
  noCoverage: number;
  timedOut: number;
}): number {
  const detected = counts.killed + counts.timedOut;
  const totalViable = counts.killed + counts.survived + counts.noCoverage + counts.timedOut;
  if (totalViable === 0) return 100.0;
  return Number(((detected / totalViable) * 100).toFixed(2));
}
