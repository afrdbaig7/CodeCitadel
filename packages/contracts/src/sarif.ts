import { z } from "zod";

import { categorySchema, confidenceSchema, evidenceStatusSchema, executorSchema, severitySchema } from "./finding.js";

/**
 * SARIF 2.1.0 output schema — the subset this project emits.
 *
 * It is validated before the log leaves the process for the same reason the JSON
 * report is: a renderer that can emit a malformed document is a renderer that
 * silently breaks someone's CI upload. Fields this project does not emit are
 * simply absent rather than filled with guesses.
 */
export const SARIF_VERSION = "2.1.0";
export const SARIF_SCHEMA_URI = "https://json.schemastore.org/sarif-2.1.0.json";

export const sarifLevelSchema = z.enum(["none", "note", "warning", "error"]);
export type SarifLevel = z.infer<typeof sarifLevelSchema>;

const sarifMessageSchema = z.object({ text: z.string().min(1) });

export const sarifRuleSchema = z.object({
  id: z.string().min(1),
  shortDescription: sarifMessageSchema,
  fullDescription: sarifMessageSchema,
  help: z.object({ text: z.string().min(1), markdown: z.string().min(1) }),
  defaultConfiguration: z.object({ level: sarifLevelSchema }),
  properties: z.object({
    category: categorySchema,
    /** The project's own five-level severity, which SARIF cannot express. */
    severity: severitySchema,
    executor: executorSchema,
    tags: z.array(z.string()),
  }),
});

export const sarifResultSchema = z.object({
  ruleId: z.string().min(1),
  ruleIndex: z.number().int().nonnegative(),
  level: sarifLevelSchema,
  message: sarifMessageSchema,
  locations: z
    .array(
      z.object({
        physicalLocation: z.object({
          artifactLocation: z.object({
            uri: z.string().min(1),
            uriBaseId: z.string().min(1),
          }),
          region: z.object({
            startLine: z.number().int().positive(),
            startColumn: z.number().int().positive(),
            endLine: z.number().int().positive(),
            endColumn: z.number().int().positive(),
            /** Omitted when the matched text was redacted. */
            snippet: z.object({ text: z.string() }).optional(),
          }),
        }),
      }),
    )
    .min(1),
  partialFingerprints: z.record(z.string(), z.string()),
  properties: z.object({
    severity: severitySchema,
    confidence: confidenceSchema,
    evidenceStatus: evidenceStatusSchema,
    /** True when the snippet was withheld; consumers must not assume source. */
    snippetRedacted: z.boolean(),
  }),
});

export const sarifLogSchema = z.object({
  $schema: z.string().min(1),
  version: z.literal(SARIF_VERSION),
  runs: z
    .array(
      z.object({
        tool: z.object({
          driver: z.object({
            name: z.literal("codecitadel"),
            version: z.string().min(1),
            rules: z.array(sarifRuleSchema),
          }),
        }),
        originalUriBaseIds: z.record(z.string(), z.object({ uri: z.string().min(1) })),
        results: z.array(sarifResultSchema),
        properties: z.object({
          scannerVersion: z.string().min(1),
          filesScanned: z.number().int().nonnegative(),
          filesSkipped: z.number().int().nonnegative(),
          truncated: z.boolean(),
          limitations: z.array(z.string().min(1)).min(1),
        }),
      }),
    )
    .min(1),
});
export type SarifLog = z.infer<typeof sarifLogSchema>;
