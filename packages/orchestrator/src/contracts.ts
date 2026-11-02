import type { ManagedRunBudget, ManagedRunStatus, ReportKind } from "@codecitadel/contracts";

export interface ManagedWorkflowInput {
  readonly runId: string;
  readonly organizationId: string;
  readonly repository: {
    readonly name: string;
    readonly commit: string | null;
    readonly branch: string | null;
  };
  readonly check: {
    readonly kind: ReportKind;
    readonly options?: Record<string, unknown>;
  };
  readonly budget: Partial<ManagedRunBudget>;
}

export type WorkflowStage =
  | "initializing"
  | "acquiring"
  | "executing"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

export interface ManagedWorkflowState {
  readonly runId: string;
  readonly organizationId: string;
  stage: WorkflowStage;
  attempt: number;
  readonly startedAt: string;
  completedAt: string | null;
  outcome: string | null;
  error: string | null;
}

export interface AcquireSourceResult {
  readonly treeDir: string;
  readonly commit: string;
}

export interface ExecuteCheckResult {
  readonly outcome: string;
  readonly reportJson: string;
}

export interface WorkflowActivities {
  acquireSource(input: ManagedWorkflowInput): Promise<AcquireSourceResult>;
  executeCheck(input: {
    readonly treeDir: string;
    readonly check: ManagedWorkflowInput["check"];
    readonly budget: Partial<ManagedRunBudget>;
  }): Promise<ExecuteCheckResult>;
  finalizeRun(input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly status: ManagedRunStatus;
    readonly outcome: string;
    readonly reportJson: string;
  }): Promise<void>;
}
