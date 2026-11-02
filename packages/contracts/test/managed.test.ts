import { describe, expect, it } from "vitest";

import {
  API_SCHEMA_VERSION,
  managedRunRequestSchema,
  managedRunResponseSchema,
  managedRunStatusSchema,
  outboxEventRecordSchema,
  outboxEventStatusSchema,
  outboxEventTypeSchema,
} from "../src/index.js";

describe("managed contracts", () => {
  it("validates a valid managed run request with defaults", () => {
    const raw = {
      schemaVersion: API_SCHEMA_VERSION,
      repository: { name: "my-service" },
      check: { kind: "scan" },
    };
    const parsed = managedRunRequestSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.repository.commit).toBeNull();
      expect(parsed.data.repository.branch).toBeNull();
      expect(parsed.data.budget.timeoutMs).toBe(60_000);
      expect(parsed.data.budget.maxFiles).toBe(500);
      expect(parsed.data.budget.maxMutants).toBe(50);
    }
  });

  it("validates a managed run response conforming to 202 Accepted", () => {
    const raw = {
      schemaVersion: API_SCHEMA_VERSION,
      runId: "run_abc123",
      status: "queued",
      statusUrl: "/api/v1/runs/run_abc123",
      queuedAt: new Date().toISOString(),
    };
    const parsed = managedRunResponseSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
  });

  it("validates an outbox event record with strict digest shape", () => {
    const raw = {
      id: "outbox_12345",
      organizationId: "org_test",
      runId: "run_test",
      eventType: "run.dispatch",
      status: "pending",
      payloadJson: '{"runId":"run_test"}',
      payloadDigest: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      retryCount: 0,
      maxRetries: 5,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      dispatchedAt: null,
      updatedAt: new Date().toISOString(),
    };
    const parsed = outboxEventRecordSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
  });

  it("rejects invalid status or malformed digest in outbox record", () => {
    const raw = {
      id: "outbox_12345",
      organizationId: "org_test",
      runId: "run_test",
      eventType: "run.dispatch",
      status: "invalid_status",
      payloadJson: "{}",
      payloadDigest: "not-a-sha256",
      retryCount: 0,
      maxRetries: 5,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      dispatchedAt: null,
      updatedAt: new Date().toISOString(),
    };
    const parsed = outboxEventRecordSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
  });
});
