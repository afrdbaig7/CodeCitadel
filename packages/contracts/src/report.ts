import { z } from "zod";

import {
  confidenceSchema,
  evidenceStatusSchema,
  findingSchema,
  severitySchema,
} from "./finding.js";
import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  ruleSummarySchema,
  scanOptionsSchema,
  severityCountsSchema,
} from "./scanner-protocol.js";

/**
 * Report schema version. Renderers and stored reports are versioned together;
 * a reader must reject a version it does not understand rather than guessing.
 */
export const REPORT_SCHEMA_VERSION = 1;

export const reportScopeSchema = z.object({
  root: z.string().min(1),
  options: scanOptionsSchema,
  /** Scanner rules that actually ran, with their versions. */
  rules: z.array(ruleSummarySchema),
  filesScanned: z.number().int().nonnegative(),
  filesSkipped: z.number().int().nonnegative(),
  bytesRead: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  /** True when a resource limit stopped the scan short of the whole tree. */
  truncated: z.boolean(),
  limitsHit: z.array(z.string()),
  /**
   * Statements about what this report does not establish. Always non-empty:
   * a report that claims no limits is misleading.
   */
  limitations: z.array(z.string().min(1)).min(1),
});

export const reportFindingSchema = findingSchema.extend({
  confidence: confidenceSchema,
  evidenceStatus: evidenceStatusSchema,
  severity: severitySchema,
});

export const codeCitadelReportSchema = z.object({
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  tool: z.object({
    name: z.literal("codecitadel"),
    version: z.string().min(1),
    scannerVersion: z.string().min(1),
    protocol: z.object({
      major: z.literal(PROTOCOL_MAJOR),
      minor: z.number().int().nonnegative().max(PROTOCOL_MINOR),
    }),
  }),
  /** Wall-clock time of report creation. Findings never depend on it. */
  generatedAt: z.iso.datetime(),
  scope: reportScopeSchema,
  summary: z.object({
    findings: z.number().int().nonnegative(),
    bySeverity: severityCountsSchema,
    byCategory: z.record(z.string(), z.number().int().nonnegative()),
  }),
  findings: z.array(reportFindingSchema),
});
export type CodeCitadelReport = z.infer<typeof codeCitadelReportSchema>;

export type ReportLimitation = CodeCitadelReport["scope"]["limitations"][number];

/** Exit codes are part of the CLI contract, not an accident of the runner. */
export const EXIT_CODES = {
  /** Policy satisfied. */
  ok: 0,
  /** A finding breached the configured policy. */
  policyBreach: 1,
  /** Invocation, infrastructure, or inconclusive-check error. */
  error: 2,
} as const;
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
