import type {
  ManagedWorkflowInput,
  ManagedWorkflowState,
  WorkflowActivities,
} from "./contracts.js";

export class ManagedVerificationWorkflow {
  readonly workflowId: string;
  private readonly state: ManagedWorkflowState;
  private cancelled = false;

  constructor(
    private readonly input: ManagedWorkflowInput,
    private readonly activities: WorkflowActivities,
  ) {
    this.workflowId = `run_${input.runId}`;
    this.state = {
      runId: input.runId,
      organizationId: input.organizationId,
      stage: "initializing",
      attempt: 1,
      startedAt: new Date().toISOString(),
      completedAt: null,
      outcome: null,
      error: null,
    };
  }

  getState(): ManagedWorkflowState {
    return { ...this.state };
  }

  cancel(): void {
    this.cancelled = true;
    this.state.stage = "cancelled";
    this.state.completedAt = new Date().toISOString();
  }

  async run(): Promise<ManagedWorkflowState> {
    if (this.cancelled) {
      await this.activities.finalizeRun({
        organizationId: this.input.organizationId,
        runId: this.input.runId,
        status: "cancelled",
        outcome: "cancelled",
        reportJson: "{}",
      });
      return this.state;
    }

    try {
      // Stage 1: Acquire source
      this.state.stage = "acquiring";
      const source = await this.activities.acquireSource(this.input);

      if (this.cancelled) {
        this.state.stage = "cancelled";
        await this.activities.finalizeRun({
          organizationId: this.input.organizationId,
          runId: this.input.runId,
          status: "cancelled",
          outcome: "cancelled",
          reportJson: "{}",
        });
        return this.state;
      }

      // Stage 2: Execute check in sandbox
      this.state.stage = "executing";
      const result = await this.activities.executeCheck({
        treeDir: source.treeDir,
        check: this.input.check,
        budget: this.input.budget,
      });

      if (this.cancelled) {
        this.state.stage = "cancelled";
        await this.activities.finalizeRun({
          organizationId: this.input.organizationId,
          runId: this.input.runId,
          status: "cancelled",
          outcome: "cancelled",
          reportJson: "{}",
        });
        return this.state;
      }

      // Stage 3: Finalize run
      this.state.stage = "finalizing";
      this.state.outcome = result.outcome;
      await this.activities.finalizeRun({
        organizationId: this.input.organizationId,
        runId: this.input.runId,
        status: "completed",
        outcome: result.outcome,
        reportJson: result.reportJson,
      });

      this.state.stage = "completed";
      this.state.completedAt = new Date().toISOString();
      return this.state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.stage = "failed";
      this.state.error = message;
      this.state.completedAt = new Date().toISOString();

      try {
        await this.activities.finalizeRun({
          organizationId: this.input.organizationId,
          runId: this.input.runId,
          status: "failed",
          outcome: `failed: ${message}`,
          reportJson: JSON.stringify({ error: message }),
        });
      } catch {}

      return this.state;
    }
  }
}
