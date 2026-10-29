import React from "react";
import {
  ArrowRight,
  BadgeCheck,
  Ban,
  FileDiff,
  ShieldAlert,
  ShieldCheck,
  Snowflake,
  Strikethrough,
  Wrench,
} from "lucide-react";
import { DiffViewer } from "../components/DiffViewer";
import type { PatchProposalItem, TestResultItem } from "../types";

interface RepairsWorkspaceProps {
  proposals: PatchProposalItem[];
}

const VERDICT_STYLE: Record<PatchProposalItem["verdict"], string> = {
  verified: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  not_verified: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  inconclusive: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  not_applied: "border-slate-500/40 bg-slate-500/10 text-slate-300",
};

const SIGNAL_LABEL: Record<PatchProposalItem["weakeningSignals"][number]["kind"], string> = {
  "suppressed-diagnostics": "suppressed diagnostics",
  "skipped-test": "skipped test",
  "dropped-assertions": "dropped assertion",
  "altered-requirements": "altered requirement",
};

const STATUS_CHIP: Record<TestResultItem["status"], string> = {
  passed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  failed: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  timed_out: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  errored: "border-orange-500/40 bg-orange-500/10 text-orange-300",
  cancelled: "border-slate-500/40 bg-slate-500/10 text-slate-300",
  skipped: "border-slate-500/40 bg-slate-500/10 text-slate-300",
};

function Chip({ status }: { status: TestResultItem["status"] }) {
  return (
    <span
      className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${STATUS_CHIP[status]}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

function transitionKind(before: TestResultItem["status"], after: TestResultItem["status"]) {
  if (before !== "passed" && after === "passed") return { label: "fixed", tone: "text-emerald-300" };
  if (before === "passed" && after !== "passed") return { label: "newly failing", tone: "text-rose-300" };
  if (before === "passed" && after === "passed") return { label: "still passing", tone: "text-slate-300" };
  return { label: "still failing", tone: "text-amber-300" };
}

export const RepairsWorkspace: React.FC<RepairsWorkspaceProps> = ({ proposals }) => {
  const [selectedId, setSelectedId] = React.useState<string | null>(proposals[0]?.id ?? null);
  const selected = proposals.find((proposal) => proposal.id === selectedId) ?? proposals[0] ?? null;

  const weakeningCount = selected?.weakeningSignals.filter(Boolean).length ?? 0;

  return (
    <div className="space-y-6">
      <section className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        <div className="glass-panel rounded-xl">
          <div className="border-b border-slate-800/80 px-4 py-3">
            <h2 className="text-sm font-semibold text-white">Candidate patches</h2>
          </div>
          <ul className="divide-y divide-slate-800/60">
            {proposals.map((proposal) => {
              const active = selected?.id === proposal.id;
              return (
                <li key={proposal.id}>
                  <button
                    onClick={() => setSelectedId(proposal.id)}
                    className={`w-full px-4 py-3 text-left transition-colors ${
                      active ? "bg-slate-800/70" : "hover:bg-slate-800/30"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[11px] text-slate-300">{proposal.id}</span>
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${VERDICT_STYLE[proposal.verdict]}`}
                      >
                        {proposal.verdict.replace("_", " ")}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-slate-400">{proposal.title}</p>
                    <div className="mt-1 flex items-center space-x-2 text-[10px] text-slate-500">
                      <span>{proposal.weakeningSignals.length} weakening signal(s)</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="glass-panel rounded-xl">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800/80 px-5 py-3">
            <div>
              <div className="flex items-center space-x-2">
                <FileDiff className="h-4 w-4 text-citadel-400" />
                <h2 className="text-sm font-semibold text-white">{selected?.title ?? "No patch selected"}</h2>
              </div>
              {selected !== null && (
                <p className="mt-1 font-mono text-[10px] text-slate-500">{selected.patchFile}</p>
              )}
            </div>
            {selected !== null && (
              <span
                className={`inline-flex items-center space-x-1 rounded border px-2 py-0.5 text-[10px] font-semibold uppercase ${VERDICT_STYLE[selected.verdict]}`}
              >
                {selected.verdict === "verified" ? (
                  <BadgeCheck className="h-3 w-3" />
                ) : (
                  <Ban className="h-3 w-3" />
                )}
                <span>{selected.verdict.replace("_", " ")}</span>
              </span>
            )}
          </div>
          <div className="p-4">
            {selected === null ? (
              <p className="text-xs text-slate-500">No candidate patch is stored.</p>
            ) : (
              <DiffViewer diff={selected.diff} maxHeight="24rem" />
            )}
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="glass-panel rounded-xl p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Wrench className="h-4 w-4 text-amber-400" />
              <h2 className="text-sm font-semibold text-white">AI weakening inspector</h2>
            </div>
            <span
              className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                weakeningCount > 0
                  ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                  : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
              }`}
            >
              {weakeningCount} signal{weakeningCount === 1 ? "" : "s"}
            </span>
          </div>

          {selected !== null && selected.weakeningSignals.length === 0 ? (
            <div className="flex items-start space-x-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
              <div className="text-xs leading-relaxed text-emerald-200">
                <p className="font-medium">No weakening signals in this patch.</p>
                <p className="mt-1 text-emerald-200/80">
                  No added <code>@ts-ignore</code>/<code>@ts-expect-error</code>, no deleted or loosened assertion, no
                  skipped or focused test, no changed requirement text. The verdict still requires every previously
                  passing test to keep passing.
                </p>
              </div>
            </div>
          ) : (
            <ul className="space-y-2">
              {(selected?.weakeningSignals ?? []).map((signal, index) => (
                <li
                  key={`${signal.kind}:${signal.location}:${index}`}
                  className="rounded-lg border border-rose-500/25 bg-rose-500/5 p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center space-x-1.5 text-[10px] font-semibold uppercase text-rose-300">
                      <ShieldAlert className="h-3.5 w-3.5" />
                      <span>{SIGNAL_LABEL[signal.kind]}</span>
                    </span>
                    <span className="font-mono text-[10px] text-slate-500">{signal.location}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-300">{signal.message}</p>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 space-y-1.5 border-t border-slate-800 pt-3 text-[10px] text-slate-500">
            <p className="flex items-center space-x-1.5">
              <Snowflake className="h-3 w-3" />
              <span>Type suppressions and skipped tests are read from the patch text, not from the runner.</span>
            </p>
            <p className="flex items-center space-x-1.5">
              <Strikethrough className="h-3 w-3" />
              <span>Deleting an assertion counts as weakening even when every remaining test passes.</span>
            </p>
          </div>
        </div>

        <div className="glass-panel rounded-xl p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Before / after execution</h2>
            {selected !== null && (
              <div className="flex items-center space-x-3 font-mono text-[10px]">
                <span className="text-emerald-300">{selected.comparison.fixed} fixed</span>
                <span className="text-slate-400">{selected.comparison.stillPassing} still passing</span>
                <span className="text-rose-300">{selected.comparison.newlyFailing} newly failing</span>
                <span className="text-amber-300">{selected.comparison.stillFailing} still failing</span>
              </div>
            )}
          </div>

          <div className="overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">Test</th>
                  <th className="py-2 pr-3 font-medium">Before</th>
                  <th className="w-6" />
                  <th className="py-2 pr-3 font-medium">After</th>
                  <th className="py-2 font-medium">Change</th>
                </tr>
              </thead>
              <tbody>
                {(selected?.transitions ?? []).map((transition) => {
                  const kind = transitionKind(transition.before, transition.after);
                  return (
                    <tr key={`${transition.fingerprint}:${transition.name}`} className="border-t border-slate-800/50">
                      <td className="py-2.5 pr-3">
                        <div className="text-slate-200">{transition.name}</div>
                        <div className="font-mono text-[10px] text-slate-500">
                          {transition.file} · {transition.fingerprint}
                        </div>
                      </td>
                      <td className="py-2.5 pr-3">
                        <Chip status={transition.before} />
                      </td>
                      <td className="py-2.5">
                        <ArrowRight className="h-3.5 w-3.5 text-slate-600" />
                      </td>
                      <td className="py-2.5 pr-3">
                        <Chip status={transition.after} />
                      </td>
                      <td className={`py-2.5 text-[11px] font-medium ${kind.tone}`}>{kind.label}</td>
                    </tr>
                  );
                })}
                {(selected?.transitions.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-500">
                      No paired before/after execution was recorded, so nothing is claimed about this patch.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {selected !== null && selected.comparison.newlyFailing > 0 && (
            <p className="mt-3 rounded border border-rose-500/30 bg-rose-500/5 p-2 text-[11px] text-rose-200">
              This patch makes {selected.comparison.newlyFailing} previously passing test(s) fail. It cannot be verified
              while that is true, whatever it fixes.
            </p>
          )}
        </div>
      </section>
    </div>
  );
};
