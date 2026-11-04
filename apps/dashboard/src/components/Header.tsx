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
    <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-md border-b border-[#eae3d5] px-6 py-3 transition-colors shadow-soft">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        {/* Brand */}
        <div className="flex items-center space-x-3">
          <div className="relative flex items-center justify-center w-9 h-9 rounded-lg bg-[#2d563f] shadow-card">
            <ShieldCheck className="w-5 h-5 text-white font-bold" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-extrabold tracking-tight text-lg text-stone-900 font-mono">CodeCitadel</span>
              <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-[#edf4ee] text-[#29593c] border border-[#cfe2d4]">
                Local Workbench
              </span>
            </div>
            <p className="text-xs text-stone-500 hidden sm:block">What changed, what could break, and what evidence do we have?</p>
          </div>
        </div>

        {/* Workspace Navigation Tabs */}
        <nav className="flex items-center space-x-1 p-1 bg-[#f5f1e7] rounded-xl border border-[#e6dfd0]">
          {navItems.map((item) => {
            const isActive = activeWorkspace === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelectWorkspace(item.id)}
                className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 ${
                  isActive
                    ? "bg-white text-stone-900 shadow-sm font-semibold border border-[#ddd5c5]"
                    : "text-stone-600 hover:text-stone-900 hover:bg-[#ebe4d6]/60"
                }`}
              >
                <span className={isActive ? "text-[#2d563f]" : "text-stone-500"}>{item.icon}</span>
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* System Health Status */}
        <div className="flex items-center space-x-3 text-xs">
          <div
            className={`flex items-center space-x-1.5 px-3 py-1 rounded-full border text-[11px] font-mono shadow-sm ${
              health.status === "ok"
                ? "bg-[#edf4ee] text-[#235336] border-[#cae0d0]"
                : "bg-[#fcf5e9] text-[#875815] border-[#ebd6b0]"
            }`}
          >
            {health.status === "ok" ? (
              <>
                <Wifi className="w-3.5 h-3.5 text-[#2e6b47]" />
                <span>API Connected</span>
              </>
            ) : (
              <>
                <WifiOff className="w-3.5 h-3.5 text-[#a16515]" />
                <span>Local Offline</span>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
