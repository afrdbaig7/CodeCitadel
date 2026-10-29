import React from "react";
import { ShieldCheck, Layers, GitCompare, CheckCircle2, Wrench, Wifi, WifiOff } from "lucide-react";
import type { WorkspaceId } from "../types";
import type { SystemHealth } from "../api";

interface HeaderProps {
  activeWorkspace: WorkspaceId;
  onSelectWorkspace: (id: WorkspaceId) => void;
  health: SystemHealth;
}

export const Header: React.FC<HeaderProps> = ({
  activeWorkspace,
  onSelectWorkspace,
  health,
}) => {
  const navItems: { id: WorkspaceId; label: string; icon: React.ReactNode }[] = [
    { id: "repository", label: "Repository", icon: <Layers className="w-4 h-4" /> },
    { id: "changes", label: "Changes & Impact", icon: <GitCompare className="w-4 h-4" /> },
    { id: "verification", label: "Verification", icon: <CheckCircle2 className="w-4 h-4" /> },
    { id: "repairs", label: "Repairs & Patches", icon: <Wrench className="w-4 h-4" /> },
  ];

  return (
    <header className="sticky top-0 z-50 glass-panel border-b border-slate-800/80 px-6 py-3 transition-colors">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        {/* Brand */}
        <div className="flex items-center space-x-3">
          <div className="relative flex items-center justify-center w-9 h-9 rounded-lg bg-gradient-to-br from-citadel-500 to-emerald-700 shadow-glow">
            <ShieldCheck className="w-5 h-5 text-slate-950 font-bold" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-extrabold tracking-tight text-lg text-white font-mono">CodeCitadel</span>
              <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-citadel-500/10 text-citadel-400 border border-citadel-500/20">
                Local Workbench
              </span>
            </div>
            <p className="text-xs text-slate-400 hidden sm:block">What changed, what could break, and what evidence do we have?</p>
          </div>
        </div>

        {/* Workspace Navigation Tabs */}
        <nav className="flex items-center space-x-1 p-1 bg-slate-900/90 rounded-xl border border-slate-800">
          {navItems.map((item) => {
            const isActive = activeWorkspace === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelectWorkspace(item.id)}
                className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 ${
                  isActive
                    ? "bg-slate-800 text-white shadow-sm font-semibold border border-slate-700/60"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
                }`}
              >
                <span className={isActive ? "text-citadel-400" : "text-slate-400"}>{item.icon}</span>
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* System Health Status */}
        <div className="flex items-center space-x-3 text-xs">
          <div
            className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-full border text-[11px] font-mono ${
              health.status === "ok"
                ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                : "bg-amber-500/10 text-amber-300 border-amber-500/30"
            }`}
          >
            {health.status === "ok" ? (
              <>
                <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                <span>API Connected</span>
              </>
            ) : (
              <>
                <WifiOff className="w-3.5 h-3.5 text-amber-400" />
                <span>Local Offline</span>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
