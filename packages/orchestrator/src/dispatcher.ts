import type { EvidenceStore } from "@codecitadel/storage";

import type { ManagedWorkflowInput } from "./contracts.js";
import type { OrchestrationEngine } from "./engine.js";

export class OutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: EvidenceStore,
    private readonly engine: OrchestrationEngine,
    private readonly intervalMs = 1000,
  ) {}

  async dispatchOnce(): Promise<number> {
    const events = await this.store.claimOutboxEvents(10);
    let dispatched = 0;

    for (const event of events) {
      try {
        if (event.eventType === "run.dispatch") {
          const payload = JSON.parse(event.payloadJson) as ManagedWorkflowInput;
          await this.engine.startWorkflow(payload);
          await this.store.markOutboxDispatched(event.id);
          dispatched += 1;
        } else if (event.eventType === "run.cancel") {
          await this.engine.cancelWorkflow(`run_${event.runId}`);
          await this.store.markOutboxDispatched(event.id);
          dispatched += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.store.markOutboxFailed(event.id, message);
      }
    }

    return dispatched;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const loop = async () => {
      if (!this.running) return;
      try {
        await this.dispatchOnce();
      } catch {}
      if (this.running) {
        this.timer = setTimeout(loop, this.intervalMs);
      }
    };

    this.timer = setTimeout(loop, this.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
