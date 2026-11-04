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
  verified: "border-[#cae2cf] bg-[#edf6ef] text-[#1e5430]",
  not_verified: "border-[#f5c6bd] bg-[#fdf0ed] text-[#932c18]",
  inconclusive: "border-[#edd7b0] bg-[#fdf7ee] text-[#8c5813]",
  not_applied: "border-[#ddd7ca] bg-[#f5f1e8] text-[#5c5448]",
};

const SIGNAL_LABEL: Record<PatchProposalItem["weakeningSignals"][number]["kind"], string> = {
  "suppressed-diagnostics": "suppressed diagnostics",
  "skipped-test": "skipped test",
  "dropped-assertions": "dropped assertion",
  "altered-requirements": "altered requirement",
};

const STATUS_CHIP: Record<TestResultItem["status"], string> = {
  passed: "border-[#cae2cf] bg-[#edf6ef] text-[#1e5430]",
  failed: "border-[#f5c6bd] bg-[#fdf0ed] text-[#932c18]",
  timed_out: "border-[#edd7b0] bg-[#fdf7ee] text-[#8c5813]",
  errored: "border-[#f6d0b9] bg-[#fdf4ed] text-[#9c4c1e]",
  cancelled: "border-[#ddd7ca] bg-[#f5f1e8] text-[#5c5448]",
  skipped: "border-[#ddd7ca] bg-[#f5f1e8] text-[#5c5448]",
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
  if (before !== "passed" && after === "passed") return { label: "fixed", tone: "text-[#245836] font-semibold" };
  if (before === "passed" && after !== "passed") return { label: "newly failing", tone: "text-[#9e331c] font-semibold" };
  if (before === "passed" && after === "passed") return { label: "still passing", tone: "text-stone-600 font-medium" };
  return { label: "still failing", tone: "text-[#8e5812] font-semibold" };
}

export const RepairsWorkspace: React.FC<RepairsWorkspaceProps> = ({ proposals }) => {
  const [selectedId, setSelectedId] = React.useState<string | null>(proposals[0]?.id ?? null);
  const selected = proposals.find((proposal) => proposal.id === selectedId) ?? proposals[0] ?? null;

  const weakeningCount = selected?.weakeningSignals.filter(Boolean).length ?? 0;

  return (
    <div className="space-y-6">
      <section className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        <div className="cream-panel rounded-xl shadow-card overflow-hidden">
          <div className="border-b border-[#eae1d3] bg-[#faf7f0] px-4 py-3">
            <h2 className="text-sm font-semibold text-stone-900">Candidate patches</h2>
          </div>
          <ul className="divide-y divide-[#ede6d8] bg-white">
            {proposals.map((proposal) => {
              const active = selected?.id === proposal.id;
              return (
                <li key={proposal.id}>
                  <button
                    onClick={() => setSelectedId(proposal.id)}
                    className={`w-full px-4 py-3 text-left transition-colors ${
                      active ? "bg-[#f5ede0]" : "hover:bg-[#faf6ee]"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[11px] text-stone-900 font-semibold">{proposal.id}</span>
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${VERDICT_STYLE[proposal.verdict]}`}
                      >
                        {proposal.verdict.replace("_", " ")}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-stone-700">{proposal.title}</p>
                    <div className="mt-1 flex items-center space-x-2 text-[10px] text-stone-500">
                      <span>{proposal.weakeningSignals.length} weakening signal(s)</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="cream-panel rounded-xl shadow-card overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#eae1d3] bg-[#faf7f0] px-5 py-3">
            <div>
              <div className="flex items-center space-x-2">
                <FileDiff className="h-4 w-4 text-[#2d5c3d]" />
                <h2 className="text-sm font-semibold text-stone-900">{selected?.title ?? "No patch selected"}</h2>
              </div>
              {selected !== null && (
                <p className="mt-1 font-mono text-[10px] text-stone-500">{selected.patchFile}</p>
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
          <div className="p-4 bg-white">
            {selected === null ? (
              <p className="text-xs text-stone-500">No candidate patch is stored.</p>
            ) : (
              <DiffViewer diff={selected.diff} maxHeight="24rem" />
            )}
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="cream-panel rounded-xl p-5 shadow-card bg-white">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Wrench className="h-4 w-4 text-[#9b5c16]" />
              <h2 className="text-sm font-semibold text-stone-900">AI weakening inspector</h2>
            </div>
            <span
              className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                weakeningCount > 0
                  ? "border-[#f5c6bd] bg-[#fdf0ed] text-[#932c18]"
                  : "border-[#cae2cf] bg-[#edf6ef] text-[#1e5430]"
              }`}
            >
              {weakeningCount} signal{weakeningCount === 1 ? "" : "s"}
            </span>
          </div>

          {selected !== null && selected.weakeningSignals.length === 0 ? (
            <div className="flex items-start space-x-2 rounded-lg border border-[#cbe1d0] bg-[#eef7f0] p-3 text-[#1e5430]">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#255e37]" />
              <div className="text-xs leading-relaxed text-[#1e5430]">
                <p className="font-semibold">No weakening signals in this patch.</p>
                <p className="mt-1 text-[#2a683e]">
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
                  className="rounded-lg border border-[#f5c6be] bg-[#fdf1ee] p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center space-x-1.5 text-[10px] font-semibold uppercase text-[#932c18]">
                      <ShieldAlert className="h-3.5 w-3.5" />
                      <span>{SIGNAL_LABEL[signal.kind]}</span>
                    </span>
                    <span className="font-mono text-[10px] text-stone-500">{signal.location}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-stone-800">{signal.message}</p>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 space-y-1.5 border-t border-[#ede7db] pt-3 text-[10px] text-stone-500">
            <p className="flex items-center space-x-1.5">
              <Snowflake className="h-3 w-3 text-stone-400" />
              <span>Type suppressions and skipped tests are read from the patch text, not from the runner.</span>
            </p>
            <p className="flex items-center space-x-1.5">
              <Strikethrough className="h-3 w-3 text-stone-400" />
              <span>Deleting an assertion counts as weakening even when every remaining test passes.</span>
            </p>
          </div>
        </div>

        <div className="cream-panel rounded-xl p-5 shadow-card bg-white">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-stone-900">Before / after execution</h2>
            {selected !== null && (
              <div className="flex items-center space-x-3 font-mono text-[10px]">
                <span className="text-[#255b37] font-semibold">{selected.comparison.fixed} fixed</span>
                <span className="text-stone-500 font-medium">{selected.comparison.stillPassing} still passing</span>
                <span className="text-[#9e331c] font-semibold">{selected.comparison.newlyFailing} newly failing</span>
                <span className="text-[#8e5812] font-semibold">{selected.comparison.stillFailing} still failing</span>
              </div>
            )}
          </div>

          <div className="overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-stone-500 border-b border-[#eae1d3]">
                <tr>
                  <th className="py-2 pr-3 font-semibold">Test</th>
                  <th className="py-2 pr-3 font-semibold">Before</th>
                  <th className="w-6" />
                  <th className="py-2 pr-3 font-semibold">After</th>
                  <th className="py-2 font-semibold">Change</th>
                </tr>
              </thead>
              <tbody>
                {(selected?.transitions ?? []).map((transition) => {
                  const kind = transitionKind(transition.before, transition.after);
                  return (
                    <tr key={`${transition.fingerprint}:${transition.name}`} className="border-t border-[#f0ebe0]">
                      <td className="py-2.5 pr-3">
                        <div className="text-stone-900 font-medium">{transition.name}</div>
                        <div className="font-mono text-[10px] text-stone-500">
                          {transition.file} · {transition.fingerprint}
                        </div>
                      </td>
                      <td className="py-2.5 pr-3">
                        <Chip status={transition.before} />
                      </td>
                      <td className="py-2.5">
                        <ArrowRight className="h-3.5 w-3.5 text-stone-400" />
                      </td>
                      <td className="py-2.5 pr-3">
                        <Chip status={transition.after} />
                      </td>
                      <td className={`py-2.5 text-[11px] font-semibold ${kind.tone}`}>{kind.label}</td>
                    </tr>
                  );
                })}
                {(selected?.transitions.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-stone-400">
                      No paired before/after execution was recorded, so nothing is claimed about this patch.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {selected !== null && selected.comparison.newlyFailing > 0 && (
            <p className="mt-3 rounded border border-[#f5c6bd] bg-[#fdf0ed] p-2 text-[11px] text-[#932c18] font-medium">
              This patch makes {selected.comparison.newlyFailing} previously passing test(s) fail. It cannot be verified
              while that is true, whatever it fixes.
            </p>
          )}
        </div>
      </section>
    </div>
  );
};
