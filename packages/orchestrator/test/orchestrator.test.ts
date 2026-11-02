import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ReportStore } from "@codecitadel/storage";
import { afterAll, describe, expect, it } from "vitest";

import {
  EmbeddedOrchestrationEngine,
  ManagedVerificationWorkflow,
  OutboxDispatcher,
  type WorkflowActivities,
} from "../src/index.js";

const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-orchestrator-test-"));
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

describe("orchestrator workflow & activities", () => {
  it("transitions workflow through acquisition, execution, and finalization", async () => {
    const store = createStore("wf-lifecycle");
    const org = store.ensureOrganization("acme");
    const { runId } = store.createManagedRun({
      organizationId: org.id,
      repository: { name: "core-api", commit: "a1b2c3", branch: "main" },
      check: { kind: "scan" },
    });

    const calls: string[] = [];
    const mockActivities: WorkflowActivities = {
      async acquireSource(input) {
        calls.push("acquireSource");
        return { treeDir: "/tmp/fake", commit: input.repository.commit ?? "HEAD" };
      },
      async executeCheck() {
        calls.push("executeCheck");
        return { outcome: "0 finding(s)", reportJson: '{"findings":[]}' };
      },
      async finalizeRun(input) {
        calls.push("finalizeRun");
        store.updateRunStatus(input.organizationId, input.runId, input.status, {
          outcome: input.outcome,
          reportJson: input.reportJson,
        });
      },
    };

    const workflow = new ManagedVerificationWorkflow(
      {
        runId,
        organizationId: org.id,
        repository: { name: "core-api", commit: "a1b2c3", branch: "main" },
        check: { kind: "scan" },
        budget: {},
      },
      mockActivities,
    );

    expect(workflow.workflowId).toBe(`run_${runId}`);
    expect(workflow.getState().stage).toBe("initializing");

    const finalState = await workflow.run();
    expect(finalState.stage).toBe("completed");
    expect(finalState.outcome).toBe("0 finding(s)");
    expect(calls).toEqual(["acquireSource", "executeCheck", "finalizeRun"]);

    const detail = store.getRun(org.id, runId);
    expect(detail?.run.status).toBe("completed");
  });

  it("handles early workflow cancellation gracefully", async () => {
    const store = createStore("wf-cancel");
    const org = store.ensureOrganization("stark");
    const { runId } = store.createManagedRun({
      organizationId: org.id,
      repository: { name: "jarvis", commit: "iron1", branch: "main" },
      check: { kind: "scan" },
    });

    const mockActivities: WorkflowActivities = {
      async acquireSource() {
        return { treeDir: "/tmp/fake", commit: "HEAD" };
      },
      async executeCheck() {
        return { outcome: "0 finding(s)", reportJson: "{}" };
      },
      async finalizeRun(input) {
        store.updateRunStatus(input.organizationId, input.runId, input.status, {
          outcome: input.outcome,
        });
      },
    };

    const workflow = new ManagedVerificationWorkflow(
      {
        runId,
        organizationId: org.id,
        repository: { name: "jarvis", commit: "iron1", branch: "main" },
        check: { kind: "scan" },
        budget: {},
      },
      mockActivities,
    );

    workflow.cancel();
    expect(workflow.getState().stage).toBe("cancelled");

    const finalState = await workflow.run();
    expect(finalState.stage).toBe("cancelled");

    const detail = store.getRun(org.id, runId);
    expect(detail?.run.status).toBe("cancelled");
  });

  it("outbox dispatcher polls pending events, starts workflow, and marks outbox dispatched", async () => {
    const store = createStore("wf-dispatcher");
    const org = store.ensureOrganization("oscorp");

    const { runId } = store.createManagedRun({
      organizationId: org.id,
      repository: { name: "web-portal", commit: "spider", branch: "main" },
      check: { kind: "scan" },
    });

    const engine = new EmbeddedOrchestrationEngine(store);
    const dispatcher = new OutboxDispatcher(store, engine);

    const count = await dispatcher.dispatchOnce();
    expect(count).toBe(1);

    // Give microtask a tick to execute workflow
    await new Promise((resolve) => setTimeout(resolve, 50));

    const state = await engine.getWorkflowState(`run_${runId}`);
    expect(state).not.toBeNull();
    expect(["executing", "finalizing", "completed"]).toContain(state?.stage);

    const detail = store.getRun(org.id, runId);
    expect(detail?.run.status).toBe("completed");
  });
});
