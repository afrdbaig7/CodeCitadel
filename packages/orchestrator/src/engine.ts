import type { EvidenceStore } from "@codecitadel/storage";

import { DefaultWorkflowActivities } from "./activities.js";
import type {
  ManagedWorkflowInput,
  ManagedWorkflowState,
  WorkflowActivities,
} from "./contracts.js";
import { ManagedVerificationWorkflow } from "./workflow.js";

export interface OrchestrationEngine {
  startWorkflow(input: ManagedWorkflowInput): Promise<string>;
  cancelWorkflow(workflowId: string): Promise<void>;
  getWorkflowState(workflowId: string): Promise<ManagedWorkflowState | null>;
}

export class EmbeddedOrchestrationEngine implements OrchestrationEngine {
  private readonly workflows = new Map<string, ManagedVerificationWorkflow>();
  private readonly activities: WorkflowActivities;

  constructor(store: EvidenceStore, customActivities?: WorkflowActivities) {
    this.activities = customActivities ?? new DefaultWorkflowActivities(store);
  }

  async startWorkflow(input: ManagedWorkflowInput): Promise<string> {
    const workflowId = `run_${input.runId}`;
    if (this.workflows.has(workflowId)) {
      // Idempotency: returning existing workflow ID without duplicate start
      return workflowId;
    }

    const workflow = new ManagedVerificationWorkflow(input, this.activities);
    this.workflows.set(workflowId, workflow);

    // Asynchronously kick off workflow run
    queueMicrotask(async () => {
      try {
        await workflow.run();
      } catch {}
    });

    return workflowId;
  }

  async cancelWorkflow(workflowId: string): Promise<void> {
    const workflow = this.workflows.get(workflowId);
    if (workflow) {
      workflow.cancel();
    }
  }

  async getWorkflowState(workflowId: string): Promise<ManagedWorkflowState | null> {
    const workflow = this.workflows.get(workflowId);
    return workflow ? workflow.getState() : null;
  }
}
