import { z } from "zod";

import {
  categorySchema,
  executorSchema,
  findingSchema,
  severitySchema,
} from "./finding.js";

/**
 * Protocol major/minor spoken by the scanner and this client.
 *
 * A major change is breaking (record type renamed, field removed, meaning
 * changed) and must be rejected. A minor change is additive and may be
 * ignored by an older reader.
 */
export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 0;

export const protocolVersionSchema = z.object({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
});
export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;

/** `sha256:<64 lowercase hex>` over the exact bytes read from disk. */
export const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/**
 * Every option is resolved before the request is sent: the scanner echoes back
 * what it actually enforced, so a silently ignored limit cannot look effective.
 */
export const scanOptionsSchema = z.object({
  maxFiles: z.number().int().positive().max(1_000_000).default(20_000),
  maxBytesPerFile: z.number().int().positive().max(64 * 1024 * 1024).default(1_048_576),
  maxTotalBytes: z.number().int().positive().max(2 * 1024 * 1024 * 1024).default(134_217_728),
  maxFindingsPerFile: z.number().int().positive().max(1000).default(50),
  snippetBytes: z.number().int().positive().max(2000).default(160),
  includeHidden: z.boolean().default(false),
  followSymlinks: z.boolean().default(false),
  exclude: z.array(z.string().min(1).max(512)).max(200).default([]),
  rules: z.array(z.string().min(3).max(120)).min(1).nullable().default(null),
});
export type ScanOptions = z.infer<typeof scanOptionsSchema>;
export type ScanOptionsInput = z.input<typeof scanOptionsSchema>;

export const scanRequestSchema = z.object({
  type: z.literal("scan"),
  requestId: z.string().min(1).max(128),
  protocol: protocolVersionSchema,
  root: z.string().min(1),
  options: scanOptionsSchema,
});
export type ScanRequest = z.infer<typeof scanRequestSchema>;

export const ruleSummarySchema = z.object({
  id: z.string().min(3),
  version: z.string().min(1),
  title: z.string().min(1),
  category: categorySchema,
  severity: severitySchema,
  executor: executorSchema,
  languages: z.array(z.string()),
  explanation: z.string(),
  remediation: z.string(),
  references: z.array(z.string()),
});
export type RuleSummary = z.infer<typeof ruleSummarySchema>;

export const skipReasonSchema = z.enum([
  "binary",
  "too_large",
  "non_utf8",
  "unreadable",
  "not_a_file",
]);
export type SkipReason = z.infer<typeof skipReasonSchema>;

export const helloEventSchema = z.object({
  type: z.literal("hello"),
  requestId: z.string(),
  scannerVersion: z.string().min(1),
  protocol: protocolVersionSchema,
  root: z.string(),
  options: z.object({
    maxFiles: z.number().int().positive(),
    maxBytesPerFile: z.number().int().positive(),
    maxTotalBytes: z.number().int().positive(),
    maxFindingsPerFile: z.number().int().positive(),
    snippetBytes: z.number().int().positive(),
    includeHidden: z.boolean(),
    followSymlinks: z.boolean(),
    exclude: z.array(z.string()),
    rules: z.array(z.string()),
  }),
  capabilities: z.object({
    rules: z.array(ruleSummarySchema),
    features: z.array(z.string()),
  }),
});
export type HelloEvent = z.infer<typeof helloEventSchema>;

export const fileEventSchema = z.object({
  type: z.literal("file"),
  requestId: z.string(),
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  digest: digestSchema.nullable(),
  skipped: skipReasonSchema.nullable(),
});
export type FileEvent = z.infer<typeof fileEventSchema>;

export const findingEventSchema = z.object({
  type: z.literal("finding"),
  requestId: z.string(),
  finding: findingSchema,
});
export type FindingEvent = z.infer<typeof findingEventSchema>;

export const warningEventSchema = z.object({
  type: z.literal("warning"),
  requestId: z.string(),
  code: z.string().min(1),
  message: z.string(),
});
export type WarningEvent = z.infer<typeof warningEventSchema>;

export const severityCountsSchema = z.object({
  critical: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  low: z.number().int().nonnegative(),
  info: z.number().int().nonnegative(),
});
export type SeverityCounts = z.infer<typeof severityCountsSchema>;

export const scanSummarySchema = z.object({
  filesSeen: z.number().int().nonnegative(),
  filesScanned: z.number().int().nonnegative(),
  filesSkipped: z.number().int().nonnegative(),
  bytesRead: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative(),
  findingsBySeverity: severityCountsSchema,
  truncated: z.boolean(),
  limitsHit: z.array(z.string()),
  durationMs: z.number().int().nonnegative(),
});
export type ScanSummary = z.infer<typeof scanSummarySchema>;

export const summaryEventSchema = z.object({
  type: z.literal("summary"),
  requestId: z.string(),
  summary: scanSummarySchema,
});
export type SummaryEvent = z.infer<typeof summaryEventSchema>;

export const doneEventSchema = z.object({
  type: z.literal("done"),
  requestId: z.string(),
  ok: z.boolean(),
  exitCode: z.number().int(),
});
export type DoneEvent = z.infer<typeof doneEventSchema>;

export const errorEventSchema = z.object({
  type: z.literal("error"),
  requestId: z.string(),
  code: z.string().min(1),
  message: z.string(),
  fatal: z.boolean(),
});
export type ErrorEvent = z.infer<typeof errorEventSchema>;

export const scannerEventSchema = z.discriminatedUnion("type", [
  helloEventSchema,
  fileEventSchema,
  findingEventSchema,
  warningEventSchema,
  summaryEventSchema,
  errorEventSchema,
  doneEventSchema,
]);
export type ScannerEvent = z.infer<typeof scannerEventSchema>;

/**
 * Output of `codecitadel-scanner --capabilities`: a one-line handshake used by
 * `doctor` and install checks without running a scan.
 */
export const capabilitiesMessageSchema = z.object({
  type: z.literal("capabilities"),
  scannerVersion: z.string().min(1),
  protocol: protocolVersionSchema,
  features: z.array(z.string()),
  rules: z.array(ruleSummarySchema),
});
export type CapabilitiesMessage = z.infer<typeof capabilitiesMessageSchema>;

/** True when the scanner's major version can be read by this client. */
export function isCompatibleProtocol(version: ProtocolVersion): boolean {
  return version.major === PROTOCOL_MAJOR;
}
