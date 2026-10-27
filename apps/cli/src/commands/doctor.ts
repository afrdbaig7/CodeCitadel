import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { PROTOCOL_MAJOR, isCompatibleProtocol } from "@codecitadel/contracts";
import { getScannerCapabilities } from "@codecitadel/core";
import {
  resolveScannerBinary,
  ScannerBinaryNotFoundError,
} from "@codecitadel/scanner-client";

const execFileAsync = promisify(execFile);

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorCommandOptions {
  format?: string;
  scanner?: string;
}

const REQUIRED_NODE_MAJOR = 24;

function checkNode(): Check {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const ok = major >= REQUIRED_NODE_MAJOR;
  return {
    name: "node",
    status: ok ? "ok" : "fail",
    detail: `v${process.versions.node} (requires >= ${REQUIRED_NODE_MAJOR})`,
  };
}

async function checkGit(): Promise<Check> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"], { timeout: 5000 });
    return { name: "git", status: "ok", detail: stdout.trim() };
  } catch {
    return {
      name: "git",
      status: "warn",
      detail: "not found; change-based commands (not implemented yet) will need it",
    };
  }
}

interface ScannerChecks {
  binary: Check;
  protocol: Check;
  rules: Check;
}

async function checkScanner(options: DoctorCommandOptions): Promise<ScannerChecks> {
  let binaryPath: string;
  let source = "unknown";
  try {
    const resolved = options.scanner
      ? resolveScannerBinary({ explicitPath: options.scanner })
      : resolveScannerBinary();
    binaryPath = resolved.path;
    source = resolved.source;
  } catch (error) {
    const detail =
      error instanceof ScannerBinaryNotFoundError
        ? error.message
        : `cannot resolve the scanner binary: ${(error as Error).message}`;
    const failed: Check = { name: "scanner binary", status: "fail", detail };
    return {
      binary: failed,
      protocol: { name: "scanner protocol", status: "fail", detail: "not checked: no binary" },
      rules: { name: "scanner rules", status: "fail", detail: "not checked: no binary" },
    };
  }

  const binary: Check = { name: "scanner binary", status: "ok", detail: `${binaryPath} (${source})` };

  try {
    const capabilities = await getScannerCapabilities({ scannerPath: binaryPath });
    const compatible = isCompatibleProtocol(capabilities.protocol);
    return {
      binary,
      protocol: {
        name: "scanner protocol",
        status: compatible ? "ok" : "fail",
        detail: `scanner ${capabilities.scannerVersion} speaks ${capabilities.protocol.major}.${capabilities.protocol.minor}, client requires major ${PROTOCOL_MAJOR}`,
      },
      rules: {
        name: "scanner rules",
        status: capabilities.rules.length > 0 ? "ok" : "warn",
        detail: `${capabilities.rules.length} rule(s), features: ${capabilities.features.join(", ") || "none"}`,
      },
    };
  } catch (error) {
    return {
      binary: { ...binary, status: "fail", detail: `${binaryPath} (${source}) cannot start: ${(error as Error).message}` },
      protocol: { name: "scanner protocol", status: "fail", detail: "not checked: scanner did not start" },
      rules: { name: "scanner rules", status: "fail", detail: "not checked: scanner did not start" },
    };
  }
}

export async function collectChecks(options: DoctorCommandOptions): Promise<Check[]> {
  const scanner = await checkScanner(options);
  return [
    checkNode(),
    { name: "platform", status: "ok", detail: `${process.platform} ${process.arch}` },
    {
      name: "working directory",
      status: "ok",
      detail: path.resolve(process.cwd()),
    },
    await checkGit(),
    scanner.binary,
    scanner.protocol,
    scanner.rules,
  ];
}

function renderHuman(checks: readonly Check[]): string {
  const width = Math.max(...checks.map((check) => check.name.length));
  const lines = ["CodeCitadel doctor", ""];
  for (const check of checks) {
    lines.push(`  ${check.name.padEnd(width)}  ${check.status.padEnd(4)}  ${check.detail}`);
  }
  const failed = checks.filter((check) => check.status === "fail").length;
  const warned = checks.filter((check) => check.status === "warn").length;
  lines.push("", `${checks.length - failed - warned} ok, ${warned} warning(s), ${failed} failure(s)`, "");
  return lines.join("\n");
}

/** Exit 0 when nothing failed. A warning is reported but does not block. */
export async function runDoctorCommand(options: DoctorCommandOptions): Promise<number> {
  const checks = await collectChecks(options);
  const failed = checks.some((check) => check.status === "fail");

  if (options.format === "json") {
    process.stdout.write(`${JSON.stringify({ ok: !failed, checks }, null, 2)}\n`);
  } else if (options.format !== undefined && options.format !== "text") {
    throw new Error(`--format must be text or json, received "${options.format}".`);
  } else {
    process.stdout.write(renderHuman(checks));
  }
  return failed ? 2 : 0;
}
