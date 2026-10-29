import React from "react";
import {
  ArrowRight,
  CheckCircle2,
  FileMinus,
  FilePlus2,
  FileWarning,
  FileCode2,
  GitBranch,
  Hash,
  TestTube2,
  XCircle,
} from "lucide-react";
import { DiffViewer } from "../components/DiffViewer";
import type { DiffFileChange, ImpactChainItem, RequirementItem } from "../types";

interface ChangesWorkspaceProps {
  changes: DiffFileChange[];
  impact: ImpactChainItem[];
  requirements: RequirementItem[];
}

const STATUS_ORDER: DiffFileChange["status"][] = ["added", "modified", "removed", "unverified"];

const STATUS_META: Record<
  DiffFileChange["status"],
  { label: string; icon: React.ReactNode; tone: string }
> = {
  added: { label: "Added", icon: <FilePlus2 className="h-3.5 w-3.5" />, tone: "text-emerald-300" },
  modified: { label: "Modified", icon: <FileCode2 className="h-3.5 w-3.5" />, tone: "text-sky-300" },
  removed: { label: "Removed", icon: <FileMinus className="h-3.5 w-3.5" />, tone: "text-rose-300" },
  unverified: { label: "Unverified", icon: <FileWarning className="h-3.5 w-3.5" />, tone: "text-amber-300" },
};

function shortDigest(digest: string): string {
  return digest.length > 24 ? `${digest.slice(0, 24)}…` : digest;
}

export const ChangesWorkspace: React.FC<ChangesWorkspaceProps> = ({ changes, impact, requirements }) => {
  const [selectedPath, setSelectedPath] = React.useState<string | null>(changes[0]?.path ?? null);
  const selected = changes.find((change) => change.path === selectedPath) ?? changes[0] ?? null;

  const totals = {
    additions: changes.reduce((sum, change) => sum + change.additions, 0),
    deletions: changes.reduce((sum, change) => sum + change.deletions, 0),
  };

  return (
    <div className="space-y-6">
      <section className="glass-panel rounded-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 px-5 py-3">
          <div className="flex items-center space-x-2">
            <GitBranch className="h-4 w-4 text-citadel-400" />
            <h2 className="text-sm font-semibold text-white">Changed files</h2>
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-400">
              {changes.length}
            </span>
          </div>
          <div className="flex items-center space-x-4 font-mono text-[11px]">
            <span className="text-emerald-400">+{totals.additions}</span>
            <span className="text-rose-400">-{totals.deletions}</span>
          </div>
        </div>

        <div className="grid gap-0 lg:grid-cols-[320px_minmax(0,1fr)]">
          <div className="max-h-[27rem] overflow-auto border-slate-800/80 p-3 lg:border-r">
            {STATUS_ORDER.map((status) => {
              const group = changes.filter((change) => change.status === status);
              if (group.length === 0) return null;
              const meta = STATUS_META[status];
              return (
                <div key={status} className="mb-4">
                  <div className={`mb-1.5 flex items-center space-x-1.5 text-[10px] uppercase tracking-wider ${meta.tone}`}>
                    {meta.icon}
                    <span>
                      {meta.label} ({group.length})
                    </span>
                  </div>
                  <ul className="space-y-1">
                    {group.map((change) => {
                      const active = selected?.path === change.path;
                      return (
                        <li key={change.path}>
                          <button
                            onClick={() => setSelectedPath(change.path)}
                            className={`w-full rounded-md border px-2.5 py-2 text-left transition-colors ${
                              active
                                ? "border-citadel-500/40 bg-citadel-500/10"
                                : "border-transparent hover:border-slate-800 hover:bg-slate-800/40"
                            }`}
                          >
                            <div className="truncate font-mono text-[11px] text-slate-300">{change.path}</div>
                            <div className="mt-0.5 flex items-center space-x-2 font-mono text-[10px]">
                              <span className="text-emerald-400">+{change.additions}</span>
                              <span className="text-rose-400">-{change.deletions}</span>
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
            {changes.length === 0 && <p className="p-4 text-xs text-slate-500">No file changes were recorded.</p>}
          </div>

          <div className="p-4">
            {selected === null ? (
              <p className="text-xs text-slate-500">Select a file to read its diff.</p>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs text-slate-200">{selected.path}</div>
                    <div className={`mt-0.5 text-[10px] uppercase tracking-wider ${STATUS_META[selected.status].tone}`}>
                      {STATUS_META[selected.status].label}
                    </div>
                  </div>
                  <span className="font-mono text-[10px] text-slate-500">
                    {selected.additions + selected.deletions} changed lines
                  </span>
                </div>
                <DiffViewer diff={selected.diff ?? ""} maxHeight="23rem" />
              </>
            )}
          </div>
        </div>
      </section>

      <section className="glass-panel rounded-xl p-5">
        <div className="mb-4 flex items-center space-x-2">
          <h2 className="text-sm font-semibold text-white">Backwards reachability</h2>
          <span className="text-[11px] text-slate-500">changed file → caller → test suite</span>
        </div>
        <div className="space-y-3">
          {impact.map((chain) => (
            <div key={`${chain.changedFile}:${chain.symbol}`} className="glass-card rounded-lg p-3.5">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="rounded border border-slate-700 bg-slate-900/80 px-2 py-1 font-mono text-slate-200">
                  {chain.changedFile}
                </span>
                <span className="text-slate-600">
                  <ArrowRight className="h-3.5 w-3.5" />
                </span>
                <span className="rounded border border-sky-500/30 bg-sky-500/10 px-2 py-1 font-mono text-sky-200">
                  {chain.callers.length === 0 ? "no callers" : chain.callers.map((caller) => caller.symbol).join(", ")}
                </span>
                <span className="text-slate-600">
                  <ArrowRight className="h-3.5 w-3.5" />
                </span>
                <span className="rounded border border-citadel-500/30 bg-citadel-500/10 px-2 py-1 font-mono text-citadel-200">
                  {chain.testFiles.length === 0 ? "no reachable tests" : `${chain.testFiles.length} test file(s)`}
                </span>
                <span className="ml-auto rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                  {chain.edgeKind}
                </span>
              </div>
              <div className="mt-2 space-y-1.5">
                {chain.callers.map((caller) => (
                  <div key={`${caller.file}:${caller.line}`} className="font-mono text-[11px] text-slate-400">
                    <span className="text-slate-500">defines {chain.symbol} · used by</span> {caller.symbol}{" "}
                    <span className="text-slate-500">
                      ({caller.file}:{caller.line})
                    </span>
                  </div>
                ))}
                {chain.testFiles.map((testFile) => (
                  <div key={testFile} className="flex items-center space-x-1.5 font-mono text-[11px] text-slate-400">
                    <TestTube2 className="h-3 w-3 text-citadel-400" />
                    <span>{testFile}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {impact.length === 0 && <p className="text-xs text-slate-500">No reachability chains were recorded.</p>}
        </div>
      </section>

      <section className="glass-panel rounded-xl">
        <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-3">
          <h2 className="text-sm font-semibold text-white">Accepted requirements</h2>
          <span className="flex items-center space-x-1 text-[10px] uppercase tracking-wider text-slate-500">
            <Hash className="h-3 w-3" />
            <span>SHA-256 of the accepted text</span>
          </span>
        </div>
        <div className="overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-900/60 text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-5 py-2 font-medium">Requirement</th>
                <th className="px-5 py-2 font-medium">Status</th>
                <th className="px-5 py-2 font-medium">Accepted digest</th>
                <th className="px-5 py-2 font-medium">Checks</th>
              </tr>
            </thead>
            <tbody>
              {requirements.map((requirement) => {
                const stale = requirement.status === "stale";
                const failed = requirement.checks.some((check) => check.status === "failed");
                return (
                  <tr key={requirement.id} className="border-t border-slate-800/50 align-top">
                    <td className="px-5 py-3">
                      <div className="font-mono text-[11px] text-citadel-300">{requirement.id}</div>
                      <p className="mt-0.5 max-w-xl text-slate-300">{requirement.statement}</p>
                      {requirement.acceptedBy !== undefined && (
                        <p className="mt-1 text-[10px] text-slate-500">
                          accepted by {requirement.acceptedBy}
                          {requirement.acceptedAt !== undefined ? ` at ${requirement.acceptedAt}` : ""}
                        </p>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`inline-flex items-center space-x-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                          stale
                            ? "badge-glow-amber border-amber-500/40 bg-amber-500/10 text-amber-300"
                            : "badge-glow-green border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                        }`}
                      >
                        {stale ? <XCircle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
                        <span>{stale ? "stale digest" : requirement.status}</span>
                      </span>
                      {stale && (
                        <p className="mt-1 max-w-[12rem] text-[10px] leading-snug text-amber-300/80">
                          The statement changed after acceptance; the recorded digest no longer covers this text.
                        </p>
                      )}
                    </td>
                    <td className="px-5 py-3 font-mono text-[10px] text-slate-400">
                      {shortDigest(requirement.digest)}
                    </td>
                    <td className="px-5 py-3">
                      <div className="space-y-1">
                        {requirement.checks.map((check) => (
                          <div key={check.id} className="flex items-center space-x-1.5 text-[11px]">
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                check.status === "passed"
                                  ? "bg-emerald-400"
                                  : check.status === "failed"
                                    ? "bg-rose-400"
                                    : "bg-slate-500"
                              }`}
                            />
                            <span className="text-slate-300">{check.id}</span>
                            <span className="font-mono text-[10px] text-slate-500">{check.fingerprint}</span>
                          </div>
                        ))}
                        {failed && <p className="text-[10px] text-rose-300">a check is failing</p>}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {requirements.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-5 py-8 text-center text-slate-500">
                    No requirement document was found for this repository.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
