import React from "react";
import { Info } from "lucide-react";
import { checkHealth, fetchRuns, type DataSource, type SystemHealth } from "./api";
import {
  SAMPLE_BUNDLES,
  SAMPLE_CHANGES,
  SAMPLE_FINDINGS,
  SAMPLE_IMPACT,
  SAMPLE_PATCH_PROPOSAL,
  SAMPLE_REPRODUCTION,
  SAMPLE_REQUIREMENTS,
  SAMPLE_WEAKENING_PATCH,
} from "./fixtures";
import { Header } from "./components/Header";
import type { VerificationRunItem, WorkspaceId } from "./types";
import { ChangesWorkspace } from "./workspaces/ChangesWorkspace";
import { RepairsWorkspace } from "./workspaces/RepairsWorkspace";
import { RepositoryWorkspace } from "./workspaces/RepositoryWorkspace";
import { VerificationWorkspace } from "./workspaces/VerificationWorkspace";

const OFFLINE_HEALTH: SystemHealth = {
  status: "offline",
  driver: "unknown",
  schemaVersion: 0,
  serverUrl: "",
  limitations: [],
};

const WORKSPACE_TITLE: Record<WorkspaceId, { title: string; question: string }> = {
  repository: {
    title: "Repository health",
    question: "What is wrong with this tree right now?",
  },
  changes: {
    title: "Changes & impact",
    question: "What changed, and what can see it?",
  },
  verification: {
    title: "Verification evidence",
    question: "What actually ran, and did the reported bug reproduce?",
  },
  repairs: {
    title: "Repairs & weakening",
    question: "Does this patch fix the cause, or does it weaken the check?",
  },
};

export const App: React.FC = () => {
  const [workspace, setWorkspace] = React.useState<WorkspaceId>("repository");
  const [health, setHealth] = React.useState<SystemHealth>(OFFLINE_HEALTH);
  const [runs, setRuns] = React.useState<VerificationRunItem[]>([]);
  const [source, setSource] = React.useState<DataSource>("preview");

  React.useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      const nextHealth = await checkHealth();
      const loaded = await fetchRuns();
      if (cancelled) return;
      setHealth(nextHealth);
      setRuns(loaded.runs);
      setSource(loaded.source);
    };

    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const meta = WORKSPACE_TITLE[workspace];

  return (
    <div className="min-h-screen bg-slate-950">
      <Header activeWorkspace={workspace} onSelectWorkspace={setWorkspace} health={health} />

      <main className="mx-auto max-w-7xl px-6 py-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-white">{meta.title}</h1>
            <p className="text-xs text-slate-400">{meta.question}</p>
          </div>
          {source === "preview" && (
            <div className="flex items-center space-x-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1 text-[11px] text-amber-200">
              <Info className="h-3.5 w-3.5" />
              <span>
                Preview dataset: {health.status === "offline" ? "the local API is not reachable." : "no runs are stored yet."}{" "}
                Every value below is a labeled fixture, not live evidence.
              </span>
            </div>
          )}
        </div>

        {workspace === "repository" && <RepositoryWorkspace findings={SAMPLE_FINDINGS} source={source} />}
        {workspace === "changes" && (
          <ChangesWorkspace changes={SAMPLE_CHANGES} impact={SAMPLE_IMPACT} requirements={SAMPLE_REQUIREMENTS} />
        )}
        {workspace === "verification" && (
          <VerificationWorkspace
            runs={runs}
            source={source}
            reproduction={SAMPLE_REPRODUCTION}
            bundles={SAMPLE_BUNDLES}
          />
        )}
        {workspace === "repairs" && (
          <RepairsWorkspace proposals={[SAMPLE_PATCH_PROPOSAL, SAMPLE_WEAKENING_PATCH]} />
        )}

        <footer className="mt-8 border-t border-slate-800/80 pt-4 text-[11px] leading-relaxed text-slate-500">
          <p>
            CodeCitadel validates and displays evidence; it does not decide that a change is correct. Findings, diffs,
            and test results are what a command recorded, and each view names the artifact it read.
          </p>
          <p className="mt-1 font-mono">
            {health.status === "ok"
              ? `api ${health.serverUrl} · schema ${health.schemaVersion} · storage ${health.driver}`
              : "api offline · start it with codecitadel serve"}
          </p>
          {health.limitations.length > 0 && (
            <ul className="mt-2 list-inside list-disc space-y-0.5">
              {health.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          )}
        </footer>
      </main>
    </div>
  );
};
