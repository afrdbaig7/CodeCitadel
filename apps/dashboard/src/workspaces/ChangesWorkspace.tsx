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
  added: { label: "Added", icon: <FilePlus2 className="h-3.5 w-3.5" />, tone: "text-[#285c39]" },
  modified: { label: "Modified", icon: <FileCode2 className="h-3.5 w-3.5" />, tone: "text-[#245373]" },
  removed: { label: "Removed", icon: <FileMinus className="h-3.5 w-3.5" />, tone: "text-[#9c341f]" },
  unverified: { label: "Unverified", icon: <FileWarning className="h-3.5 w-3.5" />, tone: "text-[#8e5a14]" },
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
      <section className="cream-panel rounded-xl shadow-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#eae1d3] bg-[#faf7f0] px-5 py-3">
          <div className="flex items-center space-x-2">
            <GitBranch className="h-4 w-4 text-[#2e5940]" />
            <h2 className="text-sm font-semibold text-stone-900">Changed files</h2>
            <span className="rounded bg-[#f0e9dc] px-2 py-0.5 font-mono text-[11px] text-stone-700">
              {changes.length}
            </span>
          </div>
          <div className="flex items-center space-x-4 font-mono text-[11px]">
            <span className="text-[#255b37] font-semibold">+{totals.additions}</span>
            <span className="text-[#9c341f] font-semibold">-{totals.deletions}</span>
          </div>
        </div>

        <div className="grid gap-0 lg:grid-cols-[320px_minmax(0,1fr)]">
          <div className="max-h-[27rem] overflow-auto border-[#eae1d3] p-3 lg:border-r bg-white">
            {STATUS_ORDER.map((status) => {
              const group = changes.filter((change) => change.status === status);
              if (group.length === 0) return null;
              const meta = STATUS_META[status];
              return (
                <div key={status} className="mb-4">
                  <div className={`mb-1.5 flex items-center space-x-1.5 text-[10px] font-semibold uppercase tracking-wider ${meta.tone}`}>
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
                                ? "border-[#cfc1a8] bg-[#f5ede0] shadow-sm"
                                : "border-transparent hover:border-[#eae1d3] hover:bg-[#faf6ee]"
                            }`}
                          >
                            <div className="truncate font-mono text-[11px] text-stone-850 font-medium">{change.path}</div>
                            <div className="mt-0.5 flex items-center space-x-2 font-mono text-[10px]">
                              <span className="text-[#255b37]">+{change.additions}</span>
                              <span className="text-[#9c341f]">-{change.deletions}</span>
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
            {changes.length === 0 && <p className="p-4 text-xs text-stone-500">No file changes were recorded.</p>}
          </div>

          <div className="p-4 bg-white">
            {selected === null ? (
              <p className="text-xs text-stone-500">Select a file to read its diff.</p>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs text-stone-900 font-semibold">{selected.path}</div>
                    <div className={`mt-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATUS_META[selected.status].tone}`}>
                      {STATUS_META[selected.status].label}
                    </div>
                  </div>
                  <span className="font-mono text-[10px] text-stone-500">
                    {selected.additions + selected.deletions} changed lines
                  </span>
                </div>
                <DiffViewer diff={selected.diff ?? ""} maxHeight="23rem" />
              </>
            )}
          </div>
        </div>
      </section>

      <section className="cream-panel rounded-xl p-5 shadow-card">
        <div className="mb-4 flex items-center space-x-2">
          <h2 className="text-sm font-semibold text-stone-900">Backwards reachability</h2>
          <span className="text-[11px] text-stone-500">changed file → caller → test suite</span>
        </div>
        <div className="space-y-3">
          {impact.map((chain) => (
            <div key={`${chain.changedFile}:${chain.symbol}`} className="cream-card rounded-lg p-3.5 shadow-card">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="rounded border border-[#dfd6c5] bg-[#f8f4ec] px-2 py-1 font-mono text-stone-800 font-medium">
                  {chain.changedFile}
                </span>
                <span className="text-stone-400">
                  <ArrowRight className="h-3.5 w-3.5" />
                </span>
                <span className="rounded border border-[#cbdde9] bg-[#eef4f8] px-2 py-1 font-mono text-[#244f6f] font-medium">
                  {chain.callers.length === 0 ? "no callers" : chain.callers.map((caller) => caller.symbol).join(", ")}
                </span>
                <span className="text-stone-400">
                  <ArrowRight className="h-3.5 w-3.5" />
                </span>
                <span className="rounded border border-[#c6dfcd] bg-[#edf6ef] px-2 py-1 font-mono text-[#225734] font-medium">
                  {chain.testFiles.length === 0 ? "no reachable tests" : `${chain.testFiles.length} test file(s)`}
                </span>
                <span className="ml-auto rounded bg-[#f2ede3] px-2 py-0.5 font-mono text-[10px] text-stone-600">
                  {chain.edgeKind}
                </span>
              </div>
              <div className="mt-2.5 space-y-1.5">
                {chain.callers.map((caller) => (
                  <div key={`${caller.file}:${caller.line}`} className="font-mono text-[11px] text-stone-600">
                    <span className="text-stone-400">defines {chain.symbol} · used by</span> <strong className="text-stone-800">{caller.symbol}</strong>{" "}
                    <span className="text-stone-400">
                      ({caller.file}:{caller.line})
                    </span>
                  </div>
                ))}
                {chain.testFiles.map((testFile) => (
                  <div key={testFile} className="flex items-center space-x-1.5 font-mono text-[11px] text-stone-700">
                    <TestTube2 className="h-3 w-3 text-[#2d5c3d]" />
                    <span>{testFile}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {impact.length === 0 && <p className="text-xs text-stone-500">No reachability chains were recorded.</p>}
        </div>
      </section>

      <section className="cream-panel rounded-xl shadow-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-[#eae1d3] bg-[#faf7f0] px-5 py-3">
          <h2 className="text-sm font-semibold text-stone-900">Accepted requirements</h2>
          <span className="flex items-center space-x-1 text-[10px] uppercase tracking-wider text-stone-500">
            <Hash className="h-3 w-3" />
            <span>SHA-256 of the accepted text</span>
          </span>
        </div>
        <div className="overflow-auto bg-white">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#f7f3eb] text-[10px] uppercase tracking-wider text-stone-500 border-b border-[#eae1d3]">
              <tr>
                <th className="px-5 py-2 font-semibold">Requirement</th>
                <th className="px-5 py-2 font-semibold">Status</th>
                <th className="px-5 py-2 font-semibold">Accepted digest</th>
                <th className="px-5 py-2 font-semibold">Checks</th>
              </tr>
            </thead>
            <tbody>
              {requirements.map((requirement) => {
                const stale = requirement.status === "stale";
                const failed = requirement.checks.some((check) => check.status === "failed");
                return (
                  <tr key={requirement.id} className="border-t border-[#f0ebe0] align-top">
                    <td className="px-5 py-3">
                      <div className="font-mono text-[11px] text-[#285737] font-semibold">{requirement.id}</div>
                      <p className="mt-0.5 max-w-xl text-stone-800">{requirement.statement}</p>
                      {requirement.acceptedBy !== undefined && (
                        <p className="mt-1 text-[10px] text-stone-400">
                          accepted by {requirement.acceptedBy}
                          {requirement.acceptedAt !== undefined ? ` at ${requirement.acceptedAt}` : ""}
                        </p>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`inline-flex items-center space-x-1 rounded border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                          stale
                            ? "border-[#ebd7b2] bg-[#fdf7ee] text-[#8c5813]"
                            : "border-[#cce2d2] bg-[#edf6f0] text-[#1e5430]"
                        }`}
                      >
                        {stale ? <XCircle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
                        <span>{stale ? "stale digest" : requirement.status}</span>
                      </span>
                      {stale && (
                        <p className="mt-1 max-w-[12rem] text-[10px] leading-snug text-[#8c5813]">
                          The statement changed after acceptance; the recorded digest no longer covers this text.
                        </p>
                      )}
                    </td>
                    <td className="px-5 py-3 font-mono text-[10px] text-stone-500">
                      {shortDigest(requirement.digest)}
                    </td>
                    <td className="px-5 py-3">
                      <div className="space-y-1">
                        {requirement.checks.map((check) => (
                          <div key={check.id} className="flex items-center space-x-1.5 text-[11px]">
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                check.status === "passed"
                                  ? "bg-[#2f6542]"
                                  : check.status === "failed"
                                    ? "bg-[#a6341f]"
                                    : "bg-stone-400"
                              }`}
                            />
                            <span className="text-stone-700">{check.id}</span>
                            <span className="font-mono text-[10px] text-stone-400">{check.fingerprint}</span>
                          </div>
                        ))}
                        {failed && <p className="text-[10px] text-[#a6341f] font-semibold">a check is failing</p>}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {requirements.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-5 py-8 text-center text-stone-400">
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
