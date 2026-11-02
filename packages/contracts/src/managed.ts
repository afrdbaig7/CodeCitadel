import { z } from "zod";

import { API_SCHEMA_VERSION, reportKindSchema } from "./api.js";

/** Status of an asynchronous managed verification run. */
export const managedRunStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type ManagedRunStatus = z.infer<typeof managedRunStatusSchema>;

export const managedRunBudgetSchema = z.strictObject({
  timeoutMs: z.number().int().positive().max(300_000).default(60_000),
  maxFiles: z.number().int().positive().max(10_000).default(500),
  maxMutants: z.number().int().positive().max(500).default(50),
});
export type ManagedRunBudget = z.infer<typeof managedRunBudgetSchema>;

/** Request to enqueue a managed verification run on the control plane. */
export const managedRunRequestSchema = z.strictObject({
  schemaVersion: z.literal(API_SCHEMA_VERSION),
  repository: z.strictObject({
    name: z.string().min(1).max(200),
    commit: z.string().min(1).max(200).nullable().default(null),
    branch: z.string().min(1).max(200).nullable().default(null),
  }),
  check: z.strictObject({
    kind: reportKindSchema,
    options: z.record(z.string(), z.unknown()).optional().default({}),
  }),
  budget: managedRunBudgetSchema.default({
    timeoutMs: 60_000,
    maxFiles: 500,
    maxMutants: 50,
  }),
});
export type ManagedRunRequest = z.infer<typeof managedRunRequestSchema>;

/** 202 Accepted response for a managed run submission. */
export const managedRunResponseSchema = z.strictObject({
  schemaVersion: z.literal(API_SCHEMA_VERSION),
  runId: z.string().min(1),
  status: managedRunStatusSchema,
  statusUrl: z.string().min(1),
  queuedAt: z.iso.datetime(),
});
export type ManagedRunResponse = z.infer<typeof managedRunResponseSchema>;

/** Outbox event types representing asynchronous orchestration intent. */
export const outboxEventTypeSchema = z.enum(["run.dispatch", "run.cancel"]);
export type OutboxEventType = z.infer<typeof outboxEventTypeSchema>;

/** Lifecycle status of a transactional outbox event. */
export const outboxEventStatusSchema = z.enum([
  "pending",
  "processing",
  "dispatched",
  "completed",
  "failed",
]);
export type OutboxEventStatus = z.infer<typeof outboxEventStatusSchema>;

/** Schema representing a durable outbox event record. */
export const outboxEventRecordSchema = z.strictObject({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  runId: z.string().min(1),
  eventType: outboxEventTypeSchema,
  status: outboxEventStatusSchema,
  payloadJson: z.string(),
  payloadDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  retryCount: z.number().int().nonnegative(),
  maxRetries: z.number().int().positive(),
  errorMessage: z.string().nullable(),
  createdAt: z.iso.datetime(),
  dispatchedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});
export type OutboxEventRecord = z.infer<typeof outboxEventRecordSchema>;
