import { z } from "zod";

/**
 * Schema version of the finding record. Bump when a field changes meaning or is
 * removed; additive optional fields keep the version.
 */
export const FINDING_SCHEMA_VERSION = 1;

export const ruleIdSchema = z
  .string()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "rule IDs look like `category/rule-name` in kebab-case",
  });

export const categorySchema = z.enum(["security", "secrets", "quality"]);
export type Category = z.infer<typeof categorySchema>;

/** Ordered from most to least severe; `info` never fails a policy on its own. */
export const severitySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export type Severity = z.infer<typeof severitySchema>;

export const SEVERITY_ORDER: readonly Severity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];

/**
 * What kind of machinery produced the finding. One rule has exactly one
 * executor; the same rule is never re-implemented in a second engine.
 */
export const executorSchema = z.enum(["native-text", "typescript-ast", "external-analyzer", "behavioral"]);
export type Executor = z.infer<typeof executorSchema>;

/** How much the finding itself has been confirmed. Independent of severity. */
export const evidenceStatusSchema = z.enum(["suspected", "reproduced", "unable_to_verify"]);
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;

export const confidenceSchema = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof confidenceSchema>;

/**
 * A location in one file. Lines and columns are 1-based; columns count UTF-16
 * code units, which is what editors and TypeScript use. `startByte` and
 * `endByte` are UTF-8 byte offsets from the scanner and must not be compared
 * with column values.
 */
export const locationSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
  startByte: z.number().int().nonnegative(),
  endByte: z.number().int().nonnegative(),
  snippet: z.string().nullable(),
  snippetRedacted: z.boolean(),
  snippetTruncated: z.boolean(),
});
export type Location = z.infer<typeof locationSchema>;

export const findingSchema = z.object({
  /** Fingerprint stable across unrelated line insertions. */
  id: z.string().regex(/^f_[0-9a-f]{16}$/),
  ruleId: ruleIdSchema,
  ruleVersion: z.string().min(1),
  ruleTitle: z.string().min(1),
  category: categorySchema,
  severity: severitySchema,
  executor: executorSchema,
  confidence: confidenceSchema,
  evidenceStatus: evidenceStatusSchema,
  message: z.string().min(1),
  explanation: z.string().min(1),
  remediation: z.string().min(1),
  references: z.array(z.string()),
  location: locationSchema,
});
export type Finding = z.infer<typeof findingSchema>;
