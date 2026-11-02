import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ReportStore } from "../src/index.js";

const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-outbox-test-"));
const openedStores: ReportStore[] = [];

afterAll(() => {
  for (const s of openedStores) {
    try {
      s.close();
    } catch {}
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {}
});

function createStore(name: string): ReportStore {
  const file = path.join(scratch, `${name}.db`);
  const artifactsDir = path.join(scratch, `${name}-artifacts`);
  const store = new ReportStore({ file, artifactsDir });
  openedStores.push(store);
  return store;
}

describe("transactional outbox & managed run storage", () => {
  it("atomically enqueues a managed run and pending outbox intent", () => {
    const store = createStore("outbox-create");
    const org = store.ensureOrganization("acme-corp");

    const { runId, outboxEventId } = store.createManagedRun({
      organizationId: org.id,
      repository: { name: "payment-api", commit: "c0ffee", branch: "main" },
      check: { kind: "scan" },
      budget: { timeoutMs: 30_000, maxFiles: 100 },
    });

    expect(runId).toMatch(/^run_/);
    expect(outboxEventId).toMatch(/^outbox_/);

    const runDetail = store.getRun(org.id, runId);
    expect(runDetail).not.toBeNull();
    expect(runDetail?.run.origin).toBe("managed");
    expect(runDetail?.run.status).toBe("queued");
    expect(runDetail?.run.kind).toBe("scan");
  });

  it("claims pending outbox events and transitions status to processing", () => {
    const store = createStore("outbox-claim");
    const org = store.ensureOrganization("globex");

    const { runId } = store.createManagedRun({
      organizationId: org.id,
      repository: { name: "service-a", commit: "abc1", branch: "main" },
      check: { kind: "scan" },
    });

    const claimed = store.claimOutboxEvents(10);
    expect(claimed.length).toBe(1);
    expect(claimed[0].runId).toBe(runId);
    expect(claimed[0].status).toBe("processing");
    expect(claimed[0].eventType).toBe("run.dispatch");

    // Second claim should return empty because event is now processing
    const emptyClaim = store.claimOutboxEvents(10);
    expect(emptyClaim.length).toBe(0);
  });

  it("marks claimed event dispatched upon completion", () => {
    const store = createStore("outbox-dispatch");
    const org = store.ensureOrganization("initech");

    store.createManagedRun({
      organizationId: org.id,
      repository: { name: "service-b", commit: "def2", branch: "main" },
      check: { kind: "scan" },
    });

    const [event] = store.claimOutboxEvents(1);
    store.markOutboxDispatched(event.id);

    // After dispatch, it is neither pending nor processing
    const nextClaim = store.claimOutboxEvents(1);
    expect(nextClaim.length).toBe(0);
  });

  it("records retry count and error message on failed dispatch", () => {
    const store = createStore("outbox-fail");
    const org = store.ensureOrganization("umbrella");

    store.createManagedRun({
      organizationId: org.id,
      repository: { name: "service-c", commit: "1234", branch: "main" },
      check: { kind: "scan" },
    });

    const [event] = store.claimOutboxEvents(1);
    store.markOutboxFailed(event.id, "Temporal cluster unreachable");

    // Event is marked failed and can be retried since retry_count (1) < max_retries (5)
    const retried = store.claimOutboxEvents(1);
    expect(retried.length).toBe(1);
    expect(retried[0].retryCount).toBe(1);
    expect(retried[0].errorMessage).toBe("Temporal cluster unreachable");
  });

  it("updates run lifecycle status and final report projection", () => {
    const store = createStore("outbox-status");
    const org = store.ensureOrganization("wayne-enterprises");

    const { runId } = store.createManagedRun({
      organizationId: org.id,
      repository: { name: "bat-computer", commit: "wayne1", branch: "main" },
      check: { kind: "scan" },
    });

    store.updateRunStatus(org.id, runId, "running");
    let detail = store.getRun(org.id, runId);
    expect(detail?.run.status).toBe("running");

    const report = {
      schemaVersion: 1,
      tool: { name: "codecitadel", version: "0.1.0" },
      findings: [],
      summary: { total: 0, high: 0, medium: 0, low: 0, info: 0 },
    };
    store.updateRunStatus(org.id, runId, "completed", {
      outcome: "0 finding(s)",
      reportJson: JSON.stringify(report),
    });

    detail = store.getRun(org.id, runId);
    expect(detail?.run.status).toBe("completed");
    expect(detail?.run.outcome).toBe("0 finding(s)");
    expect(detail?.reportJson).toBe(JSON.stringify(report));
  });
});
